//! Tauri commands for the Briefing flow. The Briefing aggregate lives in the
//! per-workspace event store; commands that mutate it append events and update
//! the `briefing_projection` row in one transaction, then emit
//! `projection_updated` so the frontend's TanStack Query caches refresh.

use std::path::Path;
use std::sync::Arc;

use rusqlite::{params, Connection};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio_util::sync::CancellationToken;
use ulid::Ulid;

use crate::briefing::{
    self, BriefingDraft, BriefingEdits, BriefingError, PathValidationResult, PersonaArtifact,
};
use crate::briefing_inflight::{GenerationKind, Inflight, InflightBriefings, InflightGuard};
use crate::commands::{emit_projection_updated, make_metadata_for};
use crate::events::append::append_events_in_tx;
use crate::events::projections::{
    self, apply_briefing_event, apply_plan_event, apply_task_event, BriefingProjection,
    PlanProjection,
};
use crate::events::types::NewEvent;
use crate::providers::{self, ProviderCache};
use crate::recent_events;
use crate::settings::{BriefingPersonaConfig, ModelChoice};
use crate::subprocess::ChildTracker;
use crate::workspace_db::open_workspace_db;
use crate::{ActiveWorkspaceState, GlobalDb};

const BRIEFING_AGGREGATE: &str = "briefing";

fn current_seq(conn: &Connection, aggregate_type: &str, aggregate_id: &str) -> Result<i64, String> {
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
        .is_none_or(|p| !p.installed);
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
    imported_sources: Option<serde_json::Value>,
    provider: String,
    model: String,
    briefing_depth: Option<String>,
    persona_config: Option<serde_json::Value>,
) -> Result<BriefingProjection, String> {
    let (workspace_id, _workspace_path) = {
        let active = app.state::<ActiveWorkspaceState>();
        let guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
        (aw.id.clone(), aw.path.clone())
    };

    let briefing_id = format!("brf_{}", Ulid::new());

    {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_mut()
            .ok_or_else(|| "no active workspace".to_string())?;
        let payload = json!({
            "workspace_id": workspace_id,
            "initial_description": initial_description,
            "imported_sources": imported_sources.unwrap_or_else(|| serde_json::Value::Array(Vec::new())),
            "provider": provider,
            "model": model,
            "briefing_depth": briefing_depth.unwrap_or_else(|| "guided".to_string()),
            "persona_config": persona_config.unwrap_or(serde_json::Value::Null),
        });
        append_briefing_event(
            &mut aw.conn,
            &briefing_id,
            "BriefingStarted",
            payload,
            "user:local",
        )?;
    }

    emit_projection_updated(&app, Some(&workspace_id), BRIEFING_AGGREGATE, &briefing_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    let active = app.state::<ActiveWorkspaceState>();
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())?;
    projections::get_briefing(&aw.conn, &briefing_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "briefing not found after insert".into())
}

// ============================================================================
// generate_briefing_draft  (initial draft)
// refine_briefing          (subsequent drafts)
// ============================================================================

/// Captured snapshot of everything `briefing::run_briefing_generation` needs to
/// run independent of whichever workspace happens to be `active` while it runs.
/// Built synchronously by the start command so the spawned task carries its
/// own context rather than re-reading from `ActiveWorkspaceState` (which would
/// race with the user switching workspace mid-generation).
struct GenerationInputs {
    workspace_id: String,
    workspace_path: String,
    provider_id: String,
    model: String,
    briefing_depth: String,
    persona_config: Option<serde_json::Value>,
    user_description: String,
    previous_draft: Option<BriefingDraft>,
    user_feedback: Option<BriefingEdits>,
    persona_artifacts: Vec<PersonaArtifact>,
}

/// Read the briefing projection on `conn` and assemble [`GenerationInputs`].
/// The caller validates `status == "active"`; this only enforces that the
/// briefing exists. Decoupled from `ActiveWorkspaceState` so the start command
/// can call it under a held lock and the spawned task could also call it
/// against an independently-opened connection if it needed to (it doesn't —
/// inputs are passed in via the spawn boundary instead).
fn load_generation_inputs_from_conn(
    conn: &Connection,
    workspace_id: &str,
    workspace_path: &str,
    briefing_id: &str,
) -> Result<GenerationInputs, String> {
    let briefing = projections::get_briefing(conn, briefing_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("briefing not found: {}", briefing_id))?;
    if briefing.status != "active" {
        return Err(format!(
            "briefing is not active (status: {})",
            briefing.status
        ));
    }
    let previous_draft = briefing
        .current_draft
        .as_ref()
        .and_then(|v| serde_json::from_value::<BriefingDraft>(v.clone()).ok());
    let user_feedback = briefing
        .pending_edits
        .as_ref()
        .and_then(|v| serde_json::from_value::<BriefingEdits>(v.clone()).ok());
    let persona_artifacts =
        serde_json::from_value::<Vec<PersonaArtifact>>(briefing.persona_artifacts.clone())
            .unwrap_or_default();
    Ok(GenerationInputs {
        workspace_id: workspace_id.to_string(),
        workspace_path: workspace_path.to_string(),
        provider_id: briefing.provider,
        model: briefing.model,
        briefing_depth: briefing.briefing_depth,
        persona_config: briefing.persona_config,
        user_description: briefing.initial_description,
        previous_draft,
        user_feedback,
        persona_artifacts,
    })
}

// ============================================================================
// Background generation: kick off and execute.
//
// Lifecycle, in order, for both initial and refine:
//
//   1. `start_generation_internal` (synchronous prelude): under the active-
//      workspace conn lock, validate the briefing exists and isn't already
//      generating, register a slot in `InflightBriefings` (this is the
//      authoritative idempotency gate — two concurrent starts can't both
//      pass), append `BriefingRefineRequested` (refine only) and
//      `BriefingGenerationStarted{kind}`. Lock is released before `spawn`
//      so the spawned task — and any later cancel command — can take its
//      own connection without contending.
//   2. `tokio::spawn(execute_generation_task(...))`: drives the LLM call,
//      and lands the appropriate terminal event:
//        - success → `BriefingDraftProduced`
//        - the cancel token was signalled → `BriefingGenerationCancelled`
//        - everything else → `BriefingGenerationFailed { reason }`
//      The spawned task opens a fresh per-workspace connection at write
//      time — by then the user may have switched workspace, and we must
//      land the event in the originating workspace's events.sqlite, not
//      whatever happens to be active. WAL mode makes the parallel writer
//      coexist cleanly with the active connection.
//   3. `InflightGuard` (held by the spawned task) drops on completion no
//      matter how the future ends — success, error, panic, runtime
//      shutdown. That guarantees the in-memory map never out-lives the
//      task that owned the slot.
// ============================================================================

/// Build the user-facing error string for `BriefingError::ParseFailed`,
/// embedding a snippet of the model's output so the UI shows something more
/// useful than `expected value at line 1 column 1`. The trim is generous
/// enough to spot the failure mode (trailing prose, missing brace, etc.) but
/// short enough to render in a banner.
fn format_briefing_error(err: BriefingError) -> String {
    match err {
        BriefingError::ParseFailed {
            last_error,
            last_output,
        } => {
            let snippet = last_output.chars().take(400).collect::<String>();
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
    }
}

/// Synchronous prelude shared by `generate_briefing_draft` and
/// `refine_briefing`. Returns the post-Started briefing projection so the
/// frontend can update its cache immediately without waiting on the
/// `projection_updated` round-trip.
fn start_generation_internal(
    app: &AppHandle,
    briefing_id: &str,
    kind: GenerationKind,
) -> Result<BriefingProjection, String> {
    let inflight = app.state::<Arc<InflightBriefings>>().inner().clone();

    // The cancel token is created up front so we can register-then-spawn:
    // if anything between fails, we still hold the token and can drop the
    // slot cleanly without stranding the caller.
    let cancel = CancellationToken::new();

    let (workspace_id, _workspace_path, inputs, projection_after_start) = {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_mut()
            .ok_or_else(|| "no active workspace".to_string())?;
        let workspace_id = aw.id.clone();
        let workspace_path = aw.path.clone();

        // Read the projection first so we get a clean error before mutating
        // anything. The `is_generating` check is defence-in-depth alongside
        // the InflightBriefings registration below — they can disagree only
        // briefly during a stale state from a prior process; the
        // workspace-activation sweep clears those before the user can
        // interact.
        let current = projections::get_briefing(&aw.conn, briefing_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("briefing not found: {}", briefing_id))?;
        if current.status != "active" {
            return Err(format!(
                "briefing is not active (status: {})",
                current.status
            ));
        }
        if current.is_generating {
            return Err("generation already in progress for this briefing".into());
        }

        // Capture inputs before the events land so we don't pick up half a
        // mutation. Inputs are derived from current_draft + pending_edits
        // which the start events don't touch — order is logically fine —
        // but reading first is also slightly cheaper because we already
        // hold the lock.
        let inputs = load_generation_inputs_from_conn(
            &aw.conn,
            &workspace_id,
            &workspace_path,
            briefing_id,
        )?;

        // Register the in-memory slot before any DB writes. This is the
        // *only* check that's safe against a near-simultaneous second start
        // — the projection lookup above is advisory because it can only
        // observe events that have already committed.
        inflight.register(
            briefing_id,
            Inflight {
                workspace_id: workspace_id.clone(),
                kind,
                started_at: now_millis(),
                cancel: cancel.clone(),
            },
        )?;

        // From here on, we own the slot — every error path below must drop
        // it. We do that with an early-return-friendly closure plus
        // explicit `inflight.remove` calls in the error arms; the spawned
        // task takes ownership via `InflightGuard` once we hand off.
        if matches!(kind, GenerationKind::Refine) {
            if let Err(e) = append_briefing_event(
                &mut aw.conn,
                briefing_id,
                "BriefingRefineRequested",
                json!({}),
                "user:local",
            ) {
                inflight.remove(briefing_id);
                return Err(e);
            }
        }
        if let Err(e) = append_briefing_event(
            &mut aw.conn,
            briefing_id,
            "BriefingGenerationStarted",
            json!({ "kind": kind.as_str() }),
            "user:local",
        ) {
            inflight.remove(briefing_id);
            return Err(e);
        }

        // Read the post-Started projection state to return; the frontend
        // uses this to flip its UI to "generating" without waiting for the
        // event-driven round-trip.
        let after = projections::get_briefing(&aw.conn, briefing_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "briefing vanished after start event".to_string())?;
        (workspace_id, workspace_path, inputs, after)
    };

    emit_projection_updated(app, Some(&workspace_id), BRIEFING_AGGREGATE, briefing_id);
    emit_projection_updated(app, Some(&workspace_id), "recent_events", &workspace_id);

    // Spawn the long-running work. The task takes ownership of an
    // `InflightGuard` so the slot is removed no matter how the future ends.
    let app_for_task = app.clone();
    let briefing_id_owned = briefing_id.to_string();
    let inflight_for_task = Arc::clone(&inflight);
    tauri::async_runtime::spawn(async move {
        let guard = InflightGuard::new(Arc::clone(&inflight_for_task), briefing_id_owned.clone());
        execute_generation_task(app_for_task, briefing_id_owned, inputs, kind, cancel, guard).await;
    });

    Ok(projection_after_start)
}

/// The spawned worker. Runs the LLM call, then opens its own per-workspace
/// connection to land exactly one terminal event. Never panics — internal
/// failures are converted to `BriefingGenerationFailed`. `_guard` is held
/// purely for its `Drop` side effect (deregister from `InflightBriefings`).
async fn execute_generation_task(
    app: AppHandle,
    briefing_id: String,
    inputs: GenerationInputs,
    _kind: GenerationKind,
    cancel: CancellationToken,
    _guard: InflightGuard,
) {
    let workspace_id = inputs.workspace_id.clone();
    let workspace_path = inputs.workspace_path.clone();

    let tracker = app.state::<Arc<ChildTracker>>().inner().clone();
    let workspace_path_buf = std::path::PathBuf::from(&workspace_path);
    let result = run_persona_orchestration(
        &app,
        &briefing_id,
        &inputs,
        &workspace_path_buf,
        tracker,
        cancel.clone(),
    )
    .await;

    let outcome = match result {
        Ok(o) => {
            let validation_results = briefing::validate_draft_paths(&workspace_path_buf, &o.draft);
            let prompt_hash = crate::prompts::hash(&o.rendered_prompt);
            TerminalOutcome::Produced {
                draft: o.draft,
                duration_ms: o.duration_ms,
                prompt_hash,
                validation_results,
            }
        }
        // Cancellation manifests as an error from the subprocess layer, but
        // the *meaning* depends on whether we asked it to stop. Trust the
        // token: if it's signalled, treat any error as a clean cancel.
        Err(_) if cancel.is_cancelled() => TerminalOutcome::Cancelled,
        Err(e) => TerminalOutcome::Failed {
            reason: format_briefing_error(e),
        },
    };

    land_terminal_event(&app, &workspace_id, &workspace_path, &briefing_id, outcome);
}

/// Discriminator for what the spawned task wants to record. Kept private to
/// this module — none of these are exposed to callers beyond the events they
/// produce.
enum TerminalOutcome {
    Produced {
        draft: BriefingDraft,
        duration_ms: u64,
        prompt_hash: String,
        validation_results: Vec<PathValidationResult>,
    },
    Failed {
        reason: String,
    },
    Cancelled,
}

/// Open a fresh per-workspace connection and append the terminal event for
/// this generation attempt. Errors are logged (via `eprintln!`) but not
/// propagated — the only caller is the spawned task and there's no upstream
/// to surface to. A failed write here would manifest as an `is_generating`
/// row that never clears, which the next workspace-activation sweep will
/// mop up (see `sweep_stale_inflight_on_activation`).
fn land_terminal_event(
    app: &AppHandle,
    workspace_id: &str,
    workspace_path: &str,
    briefing_id: &str,
    outcome: TerminalOutcome,
) {
    let mut conn = match open_workspace_db(workspace_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "briefing {}: failed to open workspace db at {}: {}",
                briefing_id, workspace_path, e
            );
            return;
        }
    };

    let notification: (&str, String) = match &outcome {
        TerminalOutcome::Produced { draft, .. } => ("Briefing draft ready", draft.title.clone()),
        TerminalOutcome::Failed { reason } => ("Briefing generation failed", reason.clone()),
        TerminalOutcome::Cancelled => (
            "Briefing generation cancelled",
            "You cancelled the run.".into(),
        ),
    };

    let result = match outcome {
        TerminalOutcome::Produced {
            draft,
            duration_ms,
            prompt_hash,
            validation_results,
        } => {
            // generation_index is the post-write count; read the current
            // value under the same conn we're about to write to.
            let next_index = match projections::get_briefing(&conn, briefing_id) {
                Ok(Some(b)) => b.generation_count + 1,
                Ok(None) => {
                    eprintln!(
                        "briefing {}: vanished from projection before terminal write",
                        briefing_id
                    );
                    return;
                }
                Err(e) => {
                    eprintln!(
                        "briefing {}: projection read failed before terminal write: {}",
                        briefing_id, e
                    );
                    return;
                }
            };
            append_briefing_event(
                &mut conn,
                briefing_id,
                "BriefingDraftProduced",
                json!({
                    "draft": draft,
                    "generation_index": next_index,
                    "prompt_template_hash": prompt_hash,
                    "duration_ms": duration_ms as i64,
                    "validation_results": validation_results,
                }),
                "system:briefing",
            )
        }
        TerminalOutcome::Failed { reason } => append_briefing_event(
            &mut conn,
            briefing_id,
            "BriefingGenerationFailed",
            json!({ "reason": reason }),
            "system:briefing",
        ),
        TerminalOutcome::Cancelled => append_briefing_event(
            &mut conn,
            briefing_id,
            "BriefingGenerationCancelled",
            json!({}),
            "user:local",
        ),
    };
    if let Err(e) = result {
        eprintln!(
            "briefing {}: failed to append terminal event: {}",
            briefing_id, e
        );
        return;
    }

    emit_projection_updated(app, Some(workspace_id), BRIEFING_AGGREGATE, briefing_id);
    emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);

    let (title, body) = notification;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!(
            "briefing {}: failed to show notification: {}",
            briefing_id, e
        );
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
struct ResolvedPersonaModel {
    persona_id: String,
    provider_id: String,
    model: String,
    fallback_used: bool,
    warning: Option<String>,
}

fn parse_persona_config(value: Option<&serde_json::Value>) -> BriefingPersonaConfig {
    value
        .and_then(|v| serde_json::from_value::<BriefingPersonaConfig>(v.clone()).ok())
        .unwrap_or_default()
}

fn choice_for_persona(
    persona_id: &str,
    default_provider: &str,
    default_model: &str,
    config: &BriefingPersonaConfig,
) -> ModelChoice {
    config
        .personas
        .get(persona_id)
        .and_then(|choice| choice.clone())
        .or_else(|| config.global_default.clone())
        .unwrap_or_else(|| ModelChoice {
            provider: default_provider.to_string(),
            model: default_model.to_string(),
        })
}

fn resolve_persona_model(
    app: &AppHandle,
    persona_id: &str,
    default_provider: &str,
    default_model: &str,
    config: &BriefingPersonaConfig,
) -> ResolvedPersonaModel {
    let preferred = choice_for_persona(persona_id, default_provider, default_model, config);
    match resolve_provider_path(app, &preferred.provider) {
        Ok(_) if providers::get(&preferred.provider).is_some() => ResolvedPersonaModel {
            persona_id: persona_id.to_string(),
            provider_id: preferred.provider,
            model: preferred.model,
            fallback_used: false,
            warning: None,
        },
        Ok(_) => ResolvedPersonaModel {
            persona_id: persona_id.to_string(),
            provider_id: default_provider.to_string(),
            model: default_model.to_string(),
            fallback_used: true,
            warning: Some(format!(
                "configured provider '{}' is unknown; fell back to briefing default",
                preferred.provider
            )),
        },
        Err(e) => ResolvedPersonaModel {
            persona_id: persona_id.to_string(),
            provider_id: default_provider.to_string(),
            model: default_model.to_string(),
            fallback_used: true,
            warning: Some(format!(
                "configured provider '{}' unavailable: {}; fell back to briefing default",
                preferred.provider, e
            )),
        },
    }
}

fn emit_briefing_note(app: &AppHandle, briefing_id: &str, text: impl Into<String>) {
    let _ = app.emit(
        briefing::BRIEFING_CHUNK_EVENT,
        briefing::BriefingChunkPayload {
            briefing_id: briefing_id.to_string(),
            text: text.into(),
        },
    );
}

fn append_briefing_event_for_workspace(
    app: &AppHandle,
    workspace_id: &str,
    workspace_path: &Path,
    briefing_id: &str,
    event_type: &str,
    payload: serde_json::Value,
    actor: &str,
) {
    let workspace_path_str = workspace_path.to_string_lossy();
    let mut conn = match open_workspace_db(&workspace_path_str) {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!(
                "briefing {}: failed to open workspace db for {}: {}",
                briefing_id, event_type, e
            );
            return;
        }
    };
    if let Err(e) = append_briefing_event(&mut conn, briefing_id, event_type, payload, actor) {
        eprintln!(
            "briefing {}: failed to append {}: {}",
            briefing_id, event_type, e
        );
        return;
    }
    emit_projection_updated(app, Some(workspace_id), BRIEFING_AGGREGATE, briefing_id);
}

fn parse_briefing_draft_from_value(
    value: serde_json::Value,
) -> Result<BriefingDraft, BriefingError> {
    serde_json::from_value(value.clone()).map_err(|e| BriefingError::ParseFailed {
        last_output: value.to_string(),
        last_error: e.to_string(),
    })
}

fn apply_persona_runtime_metadata(
    draft: &mut BriefingDraft,
    artifacts: &[PersonaArtifact],
    final_resolved: &ResolvedPersonaModel,
    briefing_depth: &str,
) {
    draft.persona_model_mapping = artifacts.iter().map(PersonaArtifact::mapping).collect();
    draft
        .persona_model_mapping
        .push(briefing::PersonaModelMapping {
            persona: briefing::persona_label(briefing::PERSONA_FINAL_SYNTHESIZER).to_string(),
            provider: final_resolved.provider_id.clone(),
            model: final_resolved.model.clone(),
            fallback_used: final_resolved.fallback_used,
            warning: final_resolved.warning.clone(),
        });
    draft.persona_artifacts = artifacts
        .iter()
        .map(|artifact| serde_json::to_value(artifact).unwrap_or_else(|_| json!({})))
        .collect();
    if draft.recommended_depth.is_none() {
        draft.recommended_depth = Some(briefing_depth.to_string());
    }
    briefing::ensure_draft_ids(draft);
}

async fn run_persona_orchestration(
    app: &AppHandle,
    briefing_id: &str,
    inputs: &GenerationInputs,
    workspace_path: &Path,
    tracker: Arc<ChildTracker>,
    cancel: CancellationToken,
) -> Result<briefing::GenerationOutcome, BriefingError> {
    let config = parse_persona_config(inputs.persona_config.as_ref());
    let mut artifacts: Vec<PersonaArtifact> = if inputs.previous_draft.is_none() {
        inputs.persona_artifacts.clone()
    } else {
        Vec::new()
    };
    let persona_ids = briefing::personas_for_depth(&inputs.briefing_depth);

    emit_briefing_note(
        app,
        briefing_id,
        format!(
            "\n\nRequirements Distillation Lab: running {} specialist persona{} for {} mode.\n",
            persona_ids.len(),
            if persona_ids.len() == 1 { "" } else { "s" },
            inputs.briefing_depth
        ),
    );

    for persona_id in persona_ids {
        if artifacts
            .iter()
            .any(|artifact| artifact.persona_id == persona_id)
        {
            emit_briefing_note(
                app,
                briefing_id,
                format!(
                    "\n→ {} already completed; reusing artifact from previous attempt.\n",
                    briefing::persona_label(persona_id)
                ),
            );
            continue;
        }
        if cancel.is_cancelled() {
            return Err(BriefingError::CliInvocationFailed(
                "briefing generation cancelled".into(),
            ));
        }
        let resolved =
            resolve_persona_model(app, persona_id, &inputs.provider_id, &inputs.model, &config);
        let provider_path = resolve_provider_path(app, &resolved.provider_id)
            .map_err(BriefingError::CliInvocationFailed)?;
        let provider = providers::get(&resolved.provider_id).ok_or_else(|| {
            BriefingError::CliInvocationFailed(format!(
                "unknown provider: {}",
                resolved.provider_id
            ))
        })?;
        emit_briefing_note(
            app,
            briefing_id,
            format!(
                "\n→ {} using {}:{}\n",
                briefing::persona_label(persona_id),
                resolved.provider_id,
                resolved.model
            ),
        );
        append_briefing_event_for_workspace(
            app,
            &inputs.workspace_id,
            workspace_path,
            briefing_id,
            "BriefingPersonaStarted",
            json!({
                "persona_id": persona_id,
                "persona_label": briefing::persona_label(persona_id),
                "provider": resolved.provider_id,
                "model": resolved.model,
            }),
            "system:briefing",
        );
        let prompt = briefing::render_persona_prompt(
            persona_id,
            &inputs.user_description,
            &inputs.briefing_depth,
            inputs.previous_draft.as_ref(),
            inputs.user_feedback.as_ref(),
            &artifacts,
        );
        let outcome = briefing::run_prompt_for_json(
            workspace_path,
            &provider_path,
            provider.as_ref(),
            &resolved.model,
            &prompt,
            None,
            Arc::clone(&tracker),
            cancel.clone(),
            Some((app.clone(), briefing_id.to_string())),
        )
        .await?;
        let artifact = PersonaArtifact {
            persona_id: resolved.persona_id,
            persona_label: briefing::persona_label(persona_id).to_string(),
            provider: resolved.provider_id,
            model: resolved.model,
            output: outcome.json,
            fallback_used: resolved.fallback_used,
            warning: resolved.warning,
            duration_ms: outcome.duration_ms,
        };
        append_briefing_event_for_workspace(
            app,
            &inputs.workspace_id,
            workspace_path,
            briefing_id,
            "BriefingPersonaArtifactProduced",
            json!({ "artifact": &artifact }),
            "system:briefing",
        );
        artifacts.push(artifact);
    }

    let final_resolved = resolve_persona_model(
        app,
        briefing::PERSONA_FINAL_SYNTHESIZER,
        &inputs.provider_id,
        &inputs.model,
        &config,
    );
    let final_provider_path = resolve_provider_path(app, &final_resolved.provider_id)
        .map_err(BriefingError::CliInvocationFailed)?;
    let final_provider = providers::get(&final_resolved.provider_id).ok_or_else(|| {
        BriefingError::CliInvocationFailed(format!(
            "unknown provider: {}",
            final_resolved.provider_id
        ))
    })?;

    emit_briefing_note(
        app,
        briefing_id,
        format!(
            "\n→ {} using {}:{}\n",
            briefing::persona_label(briefing::PERSONA_FINAL_SYNTHESIZER),
            final_resolved.provider_id,
            final_resolved.model
        ),
    );
    append_briefing_event_for_workspace(
        app,
        &inputs.workspace_id,
        workspace_path,
        briefing_id,
        "BriefingPersonaStarted",
        json!({
            "persona_id": briefing::PERSONA_FINAL_SYNTHESIZER,
            "persona_label": briefing::persona_label(briefing::PERSONA_FINAL_SYNTHESIZER),
            "provider": final_resolved.provider_id,
            "model": final_resolved.model,
        }),
        "system:briefing",
    );
    let final_prompt = briefing::render_final_synthesis_prompt(
        &inputs.user_description,
        &inputs.briefing_depth,
        inputs.persona_config.as_ref(),
        inputs.previous_draft.as_ref(),
        inputs.user_feedback.as_ref(),
        &artifacts,
    );
    let final_outcome = briefing::run_prompt_for_json(
        workspace_path,
        &final_provider_path,
        final_provider.as_ref(),
        &final_resolved.model,
        &final_prompt,
        Some(briefing::briefing_draft_schema()),
        Arc::clone(&tracker),
        cancel.clone(),
        Some((app.clone(), briefing_id.to_string())),
    )
    .await?;
    let mut draft = parse_briefing_draft_from_value(final_outcome.json.clone())?;
    apply_persona_runtime_metadata(
        &mut draft,
        &artifacts,
        &final_resolved,
        &inputs.briefing_depth,
    );

    let mut total_duration_ms =
        artifacts.iter().map(|a| a.duration_ms).sum::<u64>() + final_outcome.duration_ms;
    let quality_issues = briefing::validate_task_quality(&draft, &inputs.briefing_depth);
    if !quality_issues.is_empty() {
        emit_briefing_note(
            app,
            briefing_id,
            format!(
                "\n→ Task quality check found {} issue{}; asking {} to repair the task details.\n",
                quality_issues.len(),
                if quality_issues.len() == 1 { "" } else { "s" },
                briefing::persona_label(briefing::PERSONA_FINAL_SYNTHESIZER),
            ),
        );

        let repair_prompt = briefing::render_task_repair_prompt(
            &inputs.user_description,
            &inputs.briefing_depth,
            &draft,
            &quality_issues,
            &artifacts,
        );
        let repair_outcome = briefing::run_prompt_for_json(
            workspace_path,
            &final_provider_path,
            final_provider.as_ref(),
            &final_resolved.model,
            &repair_prompt,
            Some(briefing::briefing_draft_schema()),
            tracker,
            cancel,
            Some((app.clone(), briefing_id.to_string())),
        )
        .await?;
        total_duration_ms += repair_outcome.duration_ms;

        draft = parse_briefing_draft_from_value(repair_outcome.json.clone())?;
        apply_persona_runtime_metadata(
            &mut draft,
            &artifacts,
            &final_resolved,
            &inputs.briefing_depth,
        );
        let remaining_issues = briefing::validate_task_quality(&draft, &inputs.briefing_depth);
        if !remaining_issues.is_empty() {
            return Err(BriefingError::TaskQualityFailed(
                briefing::format_task_quality_issues(&remaining_issues),
            ));
        }
    }

    Ok(briefing::GenerationOutcome {
        draft,
        rendered_prompt: final_prompt,
        duration_ms: total_duration_ms,
    })
}

#[tauri::command]
pub fn generate_briefing_draft(
    app: AppHandle,
    briefing_id: String,
) -> Result<BriefingProjection, String> {
    start_generation_internal(&app, &briefing_id, GenerationKind::Initial)
}

#[tauri::command]
pub fn refine_briefing(app: AppHandle, briefing_id: String) -> Result<BriefingProjection, String> {
    start_generation_internal(&app, &briefing_id, GenerationKind::Refine)
}

/// Cancel the in-flight generation for `briefing_id`. Idempotent: a no-op
/// (returning Ok) when nothing is running, so the UI can fire it without
/// having to inspect state first. The spawned task is responsible for
/// landing the `BriefingGenerationCancelled` event in response to the
/// cancel signal, which is what flips the projection back to a clean
/// "active, not generating" state.
#[tauri::command]
pub fn cancel_briefing_generation(app: AppHandle, briefing_id: String) -> Result<(), String> {
    let inflight = app.state::<Arc<InflightBriefings>>();
    if let Some(entry) = inflight.get(&briefing_id) {
        entry.cancel.cancel();
    }
    Ok(())
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
        let aw = guard
            .as_mut()
            .ok_or_else(|| "no active workspace".to_string())?;
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
    // Scrub dangling depends_on refs: any reference to a task that no
    // longer exists in the draft (because the user removed it) is silently
    // dropped. The alternative — fail the accept on dangling refs — would
    // surface a confusing error after a perfectly reasonable edit.
    let surviving_ids: std::collections::HashSet<String> =
        out.tasks.iter().map(|t| t.id.clone()).collect();
    for t in &mut out.tasks {
        t.depends_on.retain(|id| surviving_ids.contains(id));
        // Also drop self-references in case a model produced one — defensive.
        t.depends_on.retain(|id| id != &t.id);
    }
    out
}

#[tauri::command]
pub fn accept_briefing(
    app: AppHandle,
    briefing_id: String,
    accept_assumptions: Option<bool>,
    global: State<'_, GlobalDb>,
) -> Result<PlanProjection, String> {
    let (workspace_id, default_phase_config) = {
        let active = app.state::<ActiveWorkspaceState>();
        let guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
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
    let (final_draft, generation_count, imported_sources) = {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_mut()
            .ok_or_else(|| "no active workspace".to_string())?;
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
        let required_unresolved = final_draft
            .ambiguity_ledger
            .iter()
            .filter(|item| {
                item.user_input_required
                    && item.status != "assumed"
                    && item.status != "user_resolved"
            })
            .count();
        if required_unresolved > 0 && !accept_assumptions.unwrap_or(false) {
            return Err(format!(
                "cannot create tasks: {} required ambiguity item{} unresolved. Accept recommended assumptions to proceed.",
                required_unresolved,
                if required_unresolved == 1 { "" } else { "s" }
            ));
        }
        (
            final_draft,
            briefing.generation_count,
            briefing.imported_sources,
        )
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
            "imported_sources": imported_sources,
        },
    });

    {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_mut()
            .ok_or_else(|| "no active workspace".to_string())?;
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

    // Allocate ULIDs up front so we can translate `depends_on` references
    // (which point at draft task IDs like `dt_01H…`) into the actual task
    // ULIDs we're about to emit. Draft IDs that don't resolve — typically
    // because the user removed the referenced task in their edits — are
    // dropped silently rather than causing the accept to fail; the brief's
    // M5 spec has the model produce conservative deps so dangling refs
    // post-edit are user-driven, not model bugs.
    let draft_to_ulid: std::collections::HashMap<String, String> = final_draft
        .tasks
        .iter()
        .map(|t| (t.id.clone(), format!("task_{}", Ulid::new())))
        .collect();

    let mut task_ids = Vec::with_capacity(final_draft.tasks.len());
    for task in &final_draft.tasks {
        let task_id = draft_to_ulid
            .get(&task.id)
            .cloned()
            .expect("draft id missing from translation map — populated above");
        let resolved_deps: Vec<String> = task
            .depends_on
            .iter()
            .filter_map(|draft_id| draft_to_ulid.get(draft_id).cloned())
            .collect();
        let payload = json!({
            "plan_id": plan_id,
            "title": task.title,
            "spec_markdown": task.spec_markdown,
            "phase_config": default_phase_config,
            "relevant_files": task.relevant_files,
            "depends_on": resolved_deps,
        });
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_mut()
            .ok_or_else(|| "no active workspace".to_string())?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            0,
            vec![NewEvent {
                event_type: "TaskCreated".into(),
                version: 4,
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
        let aw = guard
            .as_mut()
            .ok_or_else(|| "no active workspace".to_string())?;
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
    let aw = guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())?;
    projections::get_plan(&aw.conn, &plan_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "plan not found after insert".into())
}

// ============================================================================
// cancel_briefing
// ============================================================================

#[tauri::command]
pub fn cancel_briefing(app: AppHandle, briefing_id: String) -> Result<(), String> {
    // Killing the whole briefing also cancels any attempt currently running.
    // The spawned task will react by landing `BriefingGenerationCancelled`
    // shortly after we land `BriefingCancelled`; both events are
    // order-independent in the applier (each only zeroes the in-flight
    // flags), so either landing first is fine.
    {
        let inflight = app.state::<Arc<InflightBriefings>>();
        if let Some(entry) = inflight.get(&briefing_id) {
            entry.cancel.cancel();
        }
    }

    let workspace_id = {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_mut()
            .ok_or_else(|| "no active workspace".to_string())?;
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
    let aw = guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())?;
    projections::get_briefing(&aw.conn, &briefing_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_active_briefings(
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<BriefingProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())?;
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
    let aw = guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())?;
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

/// Restart-recovery: clear stale `is_generating = 1` rows that don't have a
/// matching live in-memory entry. The previous process must have died (or
/// the app was force-quit) while one or more generations were in flight; on
/// activation we synthesise `BriefingGenerationFailed` for each so the UI
/// stops showing a perpetual spinner and the user can retry.
///
/// Called from `commands::set_active_workspace`. Returns the number of rows
/// cleaned up so callers can log it; non-fatal — failures are logged and
/// swallowed because we'd rather activate a workspace with an inconsistent
/// briefing list than refuse activation entirely.
pub fn sweep_stale_inflight_on_activation(
    app: &AppHandle,
    conn: &mut Connection,
    workspace_id: &str,
) -> Result<usize, String> {
    let inflight = app.state::<Arc<InflightBriefings>>();
    let live: std::collections::HashSet<String> = inflight.snapshot_ids().into_iter().collect();

    let stale =
        projections::list_generating_briefings(conn, workspace_id).map_err(|e| e.to_string())?;
    let mut count = 0;
    for b in stale {
        if live.contains(&b.id) {
            continue; // Genuinely running in this process — leave alone.
        }
        if let Err(e) = append_briefing_event(
            conn,
            &b.id,
            "BriefingGenerationFailed",
            json!({ "reason": "interrupted by app restart" }),
            "system:briefing",
        ) {
            eprintln!(
                "briefing {}: restart sweep failed to land terminal event: {}",
                b.id, e
            );
            continue;
        }
        emit_projection_updated(app, Some(workspace_id), BRIEFING_AGGREGATE, &b.id);
        count += 1;
    }
    if count > 0 {
        emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);
    }
    Ok(count)
}

#[tauri::command]
pub fn validate_briefing_paths(
    workspace_path: String,
    draft: serde_json::Value,
) -> Result<Vec<PathValidationResult>, String> {
    let draft: BriefingDraft =
        serde_json::from_value(draft).map_err(|e| format!("invalid draft payload: {}", e))?;
    Ok(briefing::validate_draft_paths(
        Path::new(&workspace_path),
        &draft,
    ))
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
                    depends_on: vec![],
                },
                DraftTask {
                    id: "t2".into(),
                    title: "Second".into(),
                    spec_markdown: "old".into(),
                    relevant_files: vec![],
                    depends_on: vec![],
                },
            ],
            assumptions: vec![DraftAssumption {
                id: "a1".into(),
                statement: "x".into(),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn apply_edits_scrubs_dangling_depends_on_after_task_removal() {
        // t1 -> [t2]; user removes t2; the surviving t1's depends_on should be empty
        // rather than carrying a dangling reference that would fail at accept time.
        let mut d = draft_with_two_tasks();
        d.tasks[0].depends_on = vec!["t2".into()];
        let e = BriefingEdits {
            task_removals: vec!["t2".into()],
            ..Default::default()
        };
        let out = apply_edits_to_draft(&d, &e);
        assert_eq!(out.tasks.len(), 1);
        assert_eq!(out.tasks[0].id, "t1");
        assert!(
            out.tasks[0].depends_on.is_empty(),
            "dangling depends_on ref should be scrubbed",
        );
    }

    #[test]
    fn apply_edits_drops_self_dependency() {
        let mut d = draft_with_two_tasks();
        d.tasks[0].depends_on = vec!["t1".into()]; // self-loop the model snuck through
        let e = BriefingEdits::default();
        let out = apply_edits_to_draft(&d, &e);
        assert!(
            out.tasks
                .iter()
                .find(|t| t.id == "t1")
                .unwrap()
                .depends_on
                .is_empty(),
            "self-references should be dropped",
        );
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
                depends_on: vec![],
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
