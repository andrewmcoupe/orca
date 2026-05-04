//! Tauri commands for the Briefing flow. The Briefing aggregate lives in the
//! per-workspace event store; commands that mutate it append events and update
//! the `briefing_projection` row in one transaction, then emit
//! `projection_updated` so the frontend's TanStack Query caches refresh.

use std::path::Path;
use std::sync::Arc;

use rusqlite::{params, Connection};
use serde_json::json;
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;
use ulid::Ulid;

use crate::briefing::{
    self, BriefingDraft, BriefingEdits, BriefingError, PathValidationResult,
};
use crate::commands::{emit_projection_updated, make_metadata_for};
use crate::events::append::append_events_in_tx;
use crate::events::projections::{
    self, apply_briefing_event, apply_plan_event, apply_task_event, BriefingProjection,
    PlanProjection,
};
use crate::events::types::NewEvent;
use crate::providers::{self, ProviderCache};
use crate::recent_events;
use crate::subprocess::ChildTracker;
use crate::{ActiveWorkspaceState, GlobalDb};

const BRIEFING_AGGREGATE: &str = "briefing";

fn current_seq(
    conn: &Connection,
    aggregate_type: &str,
    aggregate_id: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM events WHERE aggregate_type = ?1 AND aggregate_id = ?2",
        params![aggregate_type, aggregate_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn append_briefing_event(
    conn: &mut Connection,
    briefing_id: &str,
    event_type: &str,
    payload: serde_json::Value,
    actor: &str,
) -> Result<(), String> {
    let seq = current_seq(conn, BRIEFING_AGGREGATE, briefing_id)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let outcome = append_events_in_tx(
        &tx,
        BRIEFING_AGGREGATE,
        briefing_id,
        seq,
        vec![NewEvent {
            event_type: event_type.into(),
            version: 1,
            payload: payload.to_string(),
        }],
        &make_metadata_for(actor),
    )
    .map_err(|e| e.to_string())?;
    for ev in &outcome.events {
        apply_briefing_event(&tx, ev).map_err(|e| e.to_string())?;
        recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn resolve_provider_path(app: &AppHandle, provider_id: &str) -> Result<String, String> {
    let cache = app.state::<ProviderCache>();
    let mut g = cache.0.lock().map_err(|e| e.to_string())?;
    let needs_refresh = g
        .iter()
        .find(|p| p.id == provider_id)
        .map_or(true, |p| !p.installed);
    if needs_refresh {
        *g = providers::detect_providers();
    }
    let entry = g
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("provider '{}' not registered", provider_id))?;
    if !entry.installed {
        return Err(entry
            .error
            .clone()
            .unwrap_or_else(|| format!("provider '{}' not installed", provider_id)));
    }
    entry
        .path
        .clone()
        .ok_or_else(|| format!("provider '{}' has no path", provider_id))
}

// ============================================================================
// start_briefing
// ============================================================================

#[tauri::command]
pub async fn start_briefing(
    app: AppHandle,
    initial_description: String,
    provider: String,
    model: String,
) -> Result<BriefingProjection, String> {
    let (workspace_id, _workspace_path) = {
        let active = app.state::<ActiveWorkspaceState>();
        let guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_ref().ok_or_else(|| "no active workspace".to_string())?;
        (aw.id.clone(), aw.path.clone())
    };

    let briefing_id = format!("brf_{}", Ulid::new());

    {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
        let payload = json!({
            "workspace_id": workspace_id,
            "initial_description": initial_description,
            "provider": provider,
            "model": model,
        });
        append_briefing_event(&mut aw.conn, &briefing_id, "BriefingStarted", payload, "user:local")?;
    }

    emit_projection_updated(&app, Some(&workspace_id), BRIEFING_AGGREGATE, &briefing_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    let active = app.state::<ActiveWorkspaceState>();
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
    projections::get_briefing(&aw.conn, &briefing_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "briefing not found after insert".into())
}

// ============================================================================
// generate_briefing_draft  (initial draft)
// refine_briefing          (subsequent drafts)
// ============================================================================

struct GenerationInputs {
    workspace_id: String,
    workspace_path: String,
    provider_id: String,
    model: String,
    user_description: String,
    previous_draft: Option<BriefingDraft>,
    user_feedback: Option<BriefingEdits>,
}

fn load_generation_inputs(
    app: &AppHandle,
    briefing_id: &str,
) -> Result<GenerationInputs, String> {
    let active = app.state::<ActiveWorkspaceState>();
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
    let workspace_id = aw.id.clone();
    let workspace_path = aw.path.clone();
    let briefing = projections::get_briefing(&aw.conn, briefing_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("briefing not found: {}", briefing_id))?;
    if briefing.status != "active" {
        return Err(format!("briefing is not active (status: {})", briefing.status));
    }
    let previous_draft = briefing
        .current_draft
        .as_ref()
        .and_then(|v| serde_json::from_value::<BriefingDraft>(v.clone()).ok());
    let user_feedback = briefing
        .pending_edits
        .as_ref()
        .and_then(|v| serde_json::from_value::<BriefingEdits>(v.clone()).ok());
    Ok(GenerationInputs {
        workspace_id,
        workspace_path,
        provider_id: briefing.provider,
        model: briefing.model,
        user_description: briefing.initial_description,
        previous_draft,
        user_feedback,
    })
}

async fn run_and_record_generation(
    app: &AppHandle,
    briefing_id: &str,
    inputs: GenerationInputs,
) -> Result<BriefingDraft, String> {
    let provider_path = resolve_provider_path(app, &inputs.provider_id)?;
    let provider = providers::get(&inputs.provider_id)
        .ok_or_else(|| format!("unknown provider: {}", inputs.provider_id))?;

    let tracker = app.state::<Arc<ChildTracker>>().inner().clone();
    let cancel = CancellationToken::new();

    let workspace_path = std::path::PathBuf::from(&inputs.workspace_path);
    let outcome = briefing::run_briefing_generation(
        &workspace_path,
        &provider_path,
        provider.as_ref(),
        &inputs.model,
        &inputs.user_description,
        inputs.previous_draft.as_ref(),
        inputs.user_feedback.as_ref(),
        tracker,
        cancel,
    )
    .await
    .map_err(|e| match e {
        BriefingError::ParseFailed { last_error, last_output } => {
            // Include a leading snippet of what the model actually said so the UI shows
            // something more useful than "expected value at line 1 column 1". Trim hard
            // because the textarea will render the full string verbatim.
            let snippet = last_output
                .chars()
                .take(400)
                .collect::<String>();
            let suffix = if last_output.chars().count() > 400 {
                "…"
            } else {
                ""
            };
            format!(
                "model output could not be parsed as JSON: {}\n\nModel said:\n{}{}",
                last_error, snippet, suffix
            )
        }
        other => other.to_string(),
    })?;

    let validation_results = briefing::validate_draft_paths(&workspace_path, &outcome.draft);
    let prompt_hash = crate::prompts::hash(&outcome.rendered_prompt);

    // Determine the next generation_index from the projection.
    let active = app.state::<ActiveWorkspaceState>();
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
    let current = projections::get_briefing(&aw.conn, briefing_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("briefing not found: {}", briefing_id))?;
    let next_index = current.generation_count + 1;

    let payload = json!({
        "draft": outcome.draft,
        "generation_index": next_index,
        "prompt_template_hash": prompt_hash,
        "duration_ms": outcome.duration_ms as i64,
        "validation_results": validation_results,
    });
    append_briefing_event(
        &mut aw.conn,
        briefing_id,
        "BriefingDraftProduced",
        payload,
        "system:briefing",
    )?;
    drop(guard);

    emit_projection_updated(app, Some(&inputs.workspace_id), BRIEFING_AGGREGATE, briefing_id);
    emit_projection_updated(app, Some(&inputs.workspace_id), "recent_events", &inputs.workspace_id);
    Ok(outcome.draft)
}

#[tauri::command]
pub async fn generate_briefing_draft(
    app: AppHandle,
    briefing_id: String,
) -> Result<BriefingDraft, String> {
    let inputs = load_generation_inputs(&app, &briefing_id)?;
    run_and_record_generation(&app, &briefing_id, inputs).await
}

#[tauri::command]
pub async fn refine_briefing(
    app: AppHandle,
    briefing_id: String,
) -> Result<BriefingDraft, String> {
    // Bookmark the user's intent to refine before doing the work.
    let workspace_id = {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
        let workspace_id = aw.id.clone();
        append_briefing_event(
            &mut aw.conn,
            &briefing_id,
            "BriefingRefineRequested",
            json!({}),
            "user:local",
        )?;
        workspace_id
    };
    emit_projection_updated(&app, Some(&workspace_id), BRIEFING_AGGREGATE, &briefing_id);

    let inputs = load_generation_inputs(&app, &briefing_id)?;
    run_and_record_generation(&app, &briefing_id, inputs).await
}

// ============================================================================
// apply_briefing_edits  +  push_back_assumption
// ============================================================================

#[tauri::command]
pub fn apply_briefing_edits(
    app: AppHandle,
    briefing_id: String,
    edits: serde_json::Value,
) -> Result<(), String> {
    // Validate shape against BriefingEdits before persisting; on a parse error we want a
    // clear message rather than a JSON blob the projection later chokes on.
    let parsed: BriefingEdits = serde_json::from_value(edits.clone())
        .map_err(|e| format!("invalid edits payload: {}", e))?;

    let workspace_id = {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
        let workspace_id = aw.id.clone();

        // Emit BriefingDraftEdited carrying the full edit snapshot.
        append_briefing_event(
            &mut aw.conn,
            &briefing_id,
            "BriefingDraftEdited",
            json!({ "edits": &parsed }),
            "user:local",
        )?;

        // Each pushback also gets its own dedicated event for the audit trail. Order is
        // the same as the order the user supplied; idempotency is handled at the event
        // log level (each call generates a fresh command_id, so re-applying the same
        // edits produces a new BriefingDraftEdited and new pushback rows).
        for pb in &parsed.assumption_pushbacks {
            append_briefing_event(
                &mut aw.conn,
                &briefing_id,
                "BriefingPushedBack",
                json!({
                    "assumption_id": pb.assumption_id,
                    "pushback": pb.pushback,
                }),
                "user:local",
            )?;
        }
        workspace_id
    };

    emit_projection_updated(&app, Some(&workspace_id), BRIEFING_AGGREGATE, &briefing_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);
    Ok(())
}

// ============================================================================
// accept_briefing
// ============================================================================

/// Apply a `BriefingEdits` to the latest draft to produce the final draft used for
/// Plan/Task creation. Pure function — no I/O.
fn apply_edits_to_draft(draft: &BriefingDraft, edits: &BriefingEdits) -> BriefingDraft {
    let mut out = draft.clone();
    if let Some(t) = &edits.title {
        out.title = t.clone();
    }
    if let Some(d) = &edits.description {
        out.description = d.clone();
    }
    // Apply per-task edits.
    for te in &edits.task_edits {
        if let Some(task) = out.tasks.iter_mut().find(|t| t.id == te.task_id) {
            if let Some(t) = &te.title {
                task.title = t.clone();
            }
            if let Some(s) = &te.spec_markdown {
                task.spec_markdown = s.clone();
            }
            // Removals before additions so a path can be replaced atomically.
            task.relevant_files
                .retain(|f| !te.file_removals.iter().any(|p| p == &f.path));
            for add in &te.file_additions {
                task.relevant_files.push(add.clone());
            }
        }
    }
    // Removals.
    out.tasks
        .retain(|t| !edits.task_removals.iter().any(|id| id == &t.id));
    // Additions appended in caller order.
    for add in &edits.task_additions {
        out.tasks.push(add.clone());
    }
    out
}

#[tauri::command]
pub fn accept_briefing(
    app: AppHandle,
    briefing_id: String,
    global: State<'_, GlobalDb>,
) -> Result<PlanProjection, String> {
    let (workspace_id, default_phase_config) = {
        let active = app.state::<ActiveWorkspaceState>();
        let guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_ref().ok_or_else(|| "no active workspace".to_string())?;
        let workspace_id = aw.id.clone();
        // Pull workspace settings for the default phase config to stamp on each task.
        let conn = global.0.lock().map_err(|e| e.to_string())?;
        let settings_json: String = conn
            .query_row(
                "SELECT settings_json FROM workspace_projection WHERE id = ?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "{}".to_string());
        let settings = crate::settings::WorkspaceSettings::from_json_str(&settings_json);
        let pc = serde_json::to_value(settings.default_phase_config).map_err(|e| e.to_string())?;
        (workspace_id, pc)
    };

    // Load briefing + apply pending edits to produce the final draft.
    let (final_draft, generation_count) = {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
        let briefing = projections::get_briefing(&aw.conn, &briefing_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("briefing not found: {}", briefing_id))?;
        if briefing.status != "active" {
            return Err(format!(
                "briefing is not active (status: {})",
                briefing.status
            ));
        }
        let draft: BriefingDraft = briefing
            .current_draft
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .ok_or_else(|| "briefing has no draft to accept".to_string())?;
        let edits: Option<BriefingEdits> = briefing
            .pending_edits
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let final_draft = match edits {
            Some(e) => apply_edits_to_draft(&draft, &e),
            None => draft,
        };
        if final_draft.tasks.is_empty() {
            return Err("cannot accept a briefing with no tasks".into());
        }
        (final_draft, briefing.generation_count)
    };

    // Emit PlanCreated, TaskCreated (xN), BriefingCompleted on their own aggregate
    // streams. Per the brief, partial failure is logged and surfaced — we don't try to
    // be clever with a multi-aggregate transaction.
    let plan_id = format!("plan_{}", Ulid::new());
    let plan_payload = json!({
        "workspace_id": workspace_id,
        "title": final_draft.title,
        "description": final_draft.description,
        "source": "briefing",
        "source_metadata": {
            "briefing_id": briefing_id,
            "generation_count": generation_count,
        },
    });

    {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
        // Plan aggregate.
        let seq = current_seq(&aw.conn, "plan", &plan_id)?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "plan",
            &plan_id,
            seq,
            vec![NewEvent {
                event_type: "PlanCreated".into(),
                version: 1,
                payload: plan_payload.to_string(),
            }],
            &make_metadata_for("user:local"),
        )
        .map_err(|e| e.to_string())?;
        for ev in &outcome.events {
            apply_plan_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    let mut task_ids = Vec::with_capacity(final_draft.tasks.len());
    for task in &final_draft.tasks {
        let task_id = format!("task_{}", Ulid::new());
        let payload = json!({
            "plan_id": plan_id,
            "title": task.title,
            "spec_markdown": task.spec_markdown,
            "phase_config": default_phase_config,
            "relevant_files": task.relevant_files,
        });
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            0,
            vec![NewEvent {
                event_type: "TaskCreated".into(),
                version: 3,
                payload: payload.to_string(),
            }],
            &make_metadata_for("user:local"),
        )
        .map_err(|e| e.to_string())?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        task_ids.push(task_id);
    }

    {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
        append_briefing_event(
            &mut aw.conn,
            &briefing_id,
            "BriefingCompleted",
            json!({
                "plan_id": plan_id,
                "final_generation_index": generation_count,
            }),
            "user:local",
        )?;
    }

    // One projection_updated per affected aggregate so caches refresh.
    emit_projection_updated(&app, Some(&workspace_id), BRIEFING_AGGREGATE, &briefing_id);
    emit_projection_updated(&app, Some(&workspace_id), "plan", &plan_id);
    for tid in &task_ids {
        emit_projection_updated(&app, Some(&workspace_id), "task", tid);
    }
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    let active = app.state::<ActiveWorkspaceState>();
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
    projections::get_plan(&aw.conn, &plan_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "plan not found after insert".into())
}

// ============================================================================
// cancel_briefing
// ============================================================================

#[tauri::command]
pub fn cancel_briefing(app: AppHandle, briefing_id: String) -> Result<(), String> {
    let workspace_id = {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
        let workspace_id = aw.id.clone();
        append_briefing_event(
            &mut aw.conn,
            &briefing_id,
            "BriefingCancelled",
            json!({ "reason": "user_cancelled" }),
            "user:local",
        )?;
        workspace_id
    };
    emit_projection_updated(&app, Some(&workspace_id), BRIEFING_AGGREGATE, &briefing_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);
    Ok(())
}

// ============================================================================
// Reads
// ============================================================================

#[tauri::command]
pub fn get_briefing(
    briefing_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Option<BriefingProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
    projections::get_briefing(&aw.conn, &briefing_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_active_briefings(
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<BriefingProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
    let workspace_id = aw.id.clone();
    projections::list_active_briefings(&aw.conn, &workspace_id).map_err(|e| e.to_string())
}

/// One entry in a briefing's chronological event log. Returned as a flat shape with
/// the payload pre-parsed as JSON so the frontend can render fields directly without
/// re-parsing per event.
#[derive(Debug, serde::Serialize)]
pub struct BriefingHistoryEntry {
    pub id: String,
    pub seq: i64,
    pub event_type: String,
    pub version: i64,
    pub payload: serde_json::Value,
    pub created_at: i64,
}

#[tauri::command]
pub fn list_briefing_history(
    briefing_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<BriefingHistoryEntry>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard.as_mut().ok_or_else(|| "no active workspace".to_string())?;
    let mut stmt = aw
        .conn
        .prepare(
            "SELECT id, seq, event_type, version, payload, created_at
             FROM events
             WHERE aggregate_type = ?1 AND aggregate_id = ?2
             ORDER BY seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![BRIEFING_AGGREGATE, briefing_id], |r| {
            let payload_str: String = r.get(4)?;
            let payload = serde_json::from_str(&payload_str)
                .unwrap_or(serde_json::Value::String(payload_str));
            Ok(BriefingHistoryEntry {
                id: r.get(0)?,
                seq: r.get(1)?,
                event_type: r.get(2)?,
                version: r.get(3)?,
                payload,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn validate_briefing_paths(
    workspace_path: String,
    draft: serde_json::Value,
) -> Result<Vec<PathValidationResult>, String> {
    let draft: BriefingDraft = serde_json::from_value(draft)
        .map_err(|e| format!("invalid draft payload: {}", e))?;
    Ok(briefing::validate_draft_paths(Path::new(&workspace_path), &draft))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::briefing::{
        AssumptionPushback, BriefingDraft, BriefingEdits, DraftAssumption, DraftTask,
        FileCertainty, RelevantFile, TaskEdit,
    };

    fn draft_with_two_tasks() -> BriefingDraft {
        BriefingDraft {
            title: "Old".into(),
            description: "Old desc".into(),
            tasks: vec![
                DraftTask {
                    id: "t1".into(),
                    title: "First".into(),
                    spec_markdown: "old".into(),
                    relevant_files: vec![RelevantFile {
                        path: "a.rs".into(),
                        certainty: FileCertainty::Confirmed,
                        reason: "x".into(),
                    }],
                },
                DraftTask {
                    id: "t2".into(),
                    title: "Second".into(),
                    spec_markdown: "old".into(),
                    relevant_files: vec![],
                },
            ],
            assumptions: vec![DraftAssumption {
                id: "a1".into(),
                statement: "x".into(),
            }],
        }
    }

    #[test]
    fn apply_edits_replaces_title_and_description() {
        let d = draft_with_two_tasks();
        let e = BriefingEdits {
            title: Some("New".into()),
            description: Some("New desc".into()),
            ..Default::default()
        };
        let out = apply_edits_to_draft(&d, &e);
        assert_eq!(out.title, "New");
        assert_eq!(out.description, "New desc");
    }

    #[test]
    fn apply_edits_removes_and_adds_files_atomically() {
        let d = draft_with_two_tasks();
        let e = BriefingEdits {
            task_edits: vec![TaskEdit {
                task_id: "t1".into(),
                file_removals: vec!["a.rs".into()],
                file_additions: vec![RelevantFile {
                    path: "b.rs".into(),
                    certainty: FileCertainty::Candidate,
                    reason: "added".into(),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let out = apply_edits_to_draft(&d, &e);
        let t1 = out.tasks.iter().find(|t| t.id == "t1").unwrap();
        assert_eq!(t1.relevant_files.len(), 1);
        assert_eq!(t1.relevant_files[0].path, "b.rs");
    }

    #[test]
    fn apply_edits_removes_and_adds_tasks() {
        let d = draft_with_two_tasks();
        let e = BriefingEdits {
            task_removals: vec!["t2".into()],
            task_additions: vec![DraftTask {
                id: "t3".into(),
                title: "Third".into(),
                spec_markdown: "new".into(),
                relevant_files: vec![],
            }],
            ..Default::default()
        };
        let out = apply_edits_to_draft(&d, &e);
        assert_eq!(out.tasks.len(), 2);
        assert!(out.tasks.iter().any(|t| t.id == "t1"));
        assert!(out.tasks.iter().any(|t| t.id == "t3"));
        assert!(!out.tasks.iter().any(|t| t.id == "t2"));
    }

    #[test]
    fn apply_edits_pushbacks_are_carried_in_edits_struct() {
        let d = draft_with_two_tasks();
        let e = BriefingEdits {
            assumption_pushbacks: vec![AssumptionPushback {
                assumption_id: "a1".into(),
                pushback: "actually required".into(),
            }],
            ..Default::default()
        };
        // apply_edits_to_draft does not mutate assumptions — pushbacks become input to
        // the next refinement, not draft state. Verify the draft is unchanged here and
        // that the pushback is independent data.
        let out = apply_edits_to_draft(&d, &e);
        assert_eq!(out.assumptions.len(), 1);
        assert_eq!(out.assumptions[0].id, "a1");
    }
}
