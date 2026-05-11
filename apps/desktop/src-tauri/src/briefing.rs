//! Briefing: iterative plan generation. A user describes a feature; a CLI provider
//! produces a structured draft (title, description, tasks with relevant_files,
//! assumptions); the user edits/pushes back/refines; on accept, a Plan + N Tasks
//! are created. Briefing is its own aggregate; events live in the per-workspace
//! store under `aggregate_type = "briefing"`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::providers::Provider;
use crate::subprocess::{self, ChildTracker};

/// Tauri event name for live LLM text chunks emitted during briefing generation.
/// Frontend subscribes per-briefing and accumulates the text in a transient
/// buffer (no DB persistence — option-2 of the planned rollout).
pub const BRIEFING_CHUNK_EVENT: &str = "briefing_chunk";

#[derive(Debug, Clone, Serialize)]
pub struct BriefingChunkPayload {
    pub briefing_id: String,
    /// Cumulative-friendly text fragment. Already provider-decoded — for
    /// stream-json providers we emit the human-readable `TextChunk` content.
    pub text: String,
}

#[allow(dead_code)]
const BUNDLED_BRIEFING_PROMPT: &str = include_str!("prompts/defaults/briefing.md");
#[allow(dead_code)]
const BRIEFING_PROMPT_FILENAME: &str = "briefing.md";

// ============================================================================
// Domain types
// ============================================================================

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub enum FileCertainty {
    Confirmed,
    #[default]
    Candidate,
}

impl<'de> Deserialize<'de> for FileCertainty {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let normalised = value.trim().to_ascii_lowercase();
        Ok(match normalised.as_str() {
            "confirmed" | "high" | "certain" | "definite" => Self::Confirmed,
            "candidate" | "medium" | "low" | "possible" | "unknown" | "" => Self::Candidate,
            _ => Self::Candidate,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RelevantFile {
    pub path: String,
    pub certainty: FileCertainty,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DraftTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub spec_markdown: String,
    #[serde(default)]
    pub relevant_files: Vec<RelevantFile>,
    /// IDs of *other tasks within this same draft* that this task depends
    /// on. References resolve to actual task ULIDs at briefing accept-time
    /// — see `accept_briefing` for the translation. Defaults to empty so
    /// older drafts (and models that ignore the field) replay cleanly.
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DraftAssumption {
    pub id: String,
    pub statement: String,
}

impl<'de> Deserialize<'de> for DraftAssumption {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum WireAssumption {
            Object {
                #[serde(default)]
                id: String,
                #[serde(default)]
                statement: String,
            },
            String(String),
        }

        match WireAssumption::deserialize(deserializer)? {
            WireAssumption::Object { id, statement } => Ok(Self { id, statement }),
            WireAssumption::String(statement) => Ok(Self {
                id: String::new(),
                statement,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RequestClassification {
    #[serde(default)]
    pub complexity: String,
    #[serde(default)]
    pub ambiguity: String,
    #[serde(default)]
    pub risk: String,
    #[serde(default)]
    pub likely_touched_areas: Vec<String>,
    #[serde(default)]
    pub recommended_depth: String,
    #[serde(default)]
    pub repo_scanning_needed: bool,
    #[serde(default)]
    pub multi_model_critique_justified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BriefingBudgetEstimate {
    #[serde(default)]
    pub depth: String,
    #[serde(default)]
    pub cost_level: String,
    #[serde(default)]
    pub risk_level: String,
    #[serde(default)]
    pub confidence: f32,
    #[serde(default)]
    pub token_strategy: String,
    #[serde(default)]
    pub expensive_steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AmbiguityItem {
    pub id: String,
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub why_it_matters: String,
    #[serde(default)]
    pub risk_if_unanswered: String,
    #[serde(default)]
    pub recommended_default_assumption: String,
    #[serde(default)]
    pub user_input_required: bool,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub user_answer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PersonaModelMapping {
    pub persona: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub fallback_used: bool,
    #[serde(default)]
    pub warning: Option<String>,
}

impl<'de> Deserialize<'de> for PersonaModelMapping {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireMapping {
            #[serde(default)]
            persona: String,
            #[serde(default)]
            provider: String,
            #[serde(default)]
            model: String,
            #[serde(default)]
            fallback_used: bool,
            #[serde(default)]
            warning: Option<String>,
        }

        let wire = WireMapping::deserialize(deserializer)?;
        Ok(Self {
            persona: wire.persona,
            provider: wire.provider,
            model: wire.model,
            fallback_used: wire.fallback_used,
            warning: wire.warning,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StructuredBrief {
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub user_value: String,
    #[serde(default)]
    pub target_users: Vec<String>,
    #[serde(default)]
    pub non_goals: Vec<String>,
    #[serde(default)]
    pub codebase_context: String,
    #[serde(default)]
    pub relevant_files: Vec<RelevantFile>,
    #[serde(default)]
    pub required_behavior: Vec<String>,
    #[serde(default)]
    pub ux_requirements: Vec<String>,
    #[serde(default)]
    pub data_api_requirements: Vec<String>,
    #[serde(default)]
    pub permissions_security: Vec<String>,
    #[serde(default)]
    pub edge_cases: Vec<String>,
    #[serde(default)]
    pub tests_required: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub approved_assumptions: Vec<String>,
    #[serde(default)]
    pub open_questions: Vec<String>,
    #[serde(default)]
    pub task_graph: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BriefingDraft {
    pub title: String,
    pub description: String,
    pub tasks: Vec<DraftTask>,
    pub assumptions: Vec<DraftAssumption>,
    #[serde(default)]
    pub classification: Option<RequestClassification>,
    #[serde(default)]
    pub budget_estimate: Option<BriefingBudgetEstimate>,
    #[serde(default)]
    pub ambiguity_ledger: Vec<AmbiguityItem>,
    #[serde(default)]
    pub structured_brief: Option<StructuredBrief>,
    #[serde(default)]
    pub approved_assumptions: Vec<String>,
    #[serde(default)]
    pub open_questions: Vec<String>,
    #[serde(default)]
    pub persona_model_mapping: Vec<PersonaModelMapping>,
    #[serde(default)]
    pub persona_artifacts: Vec<serde_json::Value>,
    #[serde(default)]
    pub readiness_status: Option<String>,
    #[serde(default)]
    pub confidence_score: Option<f32>,
    #[serde(default)]
    pub recommended_depth: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskEdit {
    pub task_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub spec_markdown: Option<String>,
    #[serde(default)]
    pub file_additions: Vec<RelevantFile>,
    #[serde(default)]
    pub file_removals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssumptionPushback {
    pub assumption_id: String,
    pub pushback: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AmbiguityAnswer {
    pub ambiguity_id: String,
    pub answer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BriefingEdits {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub task_edits: Vec<TaskEdit>,
    #[serde(default)]
    pub task_additions: Vec<DraftTask>,
    #[serde(default)]
    pub task_removals: Vec<String>,
    #[serde(default)]
    pub assumption_pushbacks: Vec<AssumptionPushback>,
    #[serde(default)]
    pub ambiguity_answers: Vec<AmbiguityAnswer>,
    /// Freeform "anything else" feedback the user wants the model to consider
    /// during refinement. Passed through to the prompt as a dedicated section
    /// so the model treats it as top-level guidance rather than burying it.
    #[serde(default)]
    pub general_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathValidationResult {
    pub task_id: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskQualityIssue {
    pub task_id: String,
    pub task_title: String,
    pub field: String,
    pub message: String,
}

// ============================================================================
// Errors
// ============================================================================

#[derive(Debug, Error)]
pub enum BriefingError {
    #[error("workspace path not found: {0}")]
    WorkspaceNotFound(String),
    #[error("provider not installed or unavailable: {0}")]
    #[allow(dead_code)]
    ProviderUnavailable(String),
    #[error("CLI invocation failed: {0}")]
    CliInvocationFailed(String),
    #[error("model output could not be parsed as JSON after retry")]
    ParseFailed {
        last_output: String,
        last_error: String,
    },
    #[error("briefing task quality validation failed: {0}")]
    TaskQualityFailed(String),
    #[allow(dead_code)]
    #[error("prompt template error: {0}")]
    Prompt(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

// ============================================================================
// Prompt templating
// ============================================================================

#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct BriefingPromptContext<'a> {
    user_description: &'a str,
    briefing_depth: &'a str,
    persona_config_json: Option<String>,
    previous_draft: bool,
    previous_draft_json: Option<String>,
    user_feedback_json: Option<String>,
    /// User's freeform refinement notes, surfaced as its own section in the
    /// prompt so the model can't miss it.
    general_notes: Option<String>,
}

#[allow(dead_code)]
fn briefing_prompt_path(workspace_path: &Path) -> PathBuf {
    workspace_path
        .join(crate::workspace_db::WORKSPACE_DIR)
        .join("prompts")
        .join(BRIEFING_PROMPT_FILENAME)
}

#[allow(dead_code)]
pub fn resolve_briefing_prompt(workspace_path: &Path) -> Result<String, BriefingError> {
    let p = briefing_prompt_path(workspace_path);
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(BUNDLED_BRIEFING_PROMPT.to_string())
        }
        Err(e) => Err(BriefingError::Io(e)),
    }
}

#[allow(dead_code)]
pub fn render_briefing_prompt(
    template: &str,
    user_description: &str,
    briefing_depth: &str,
    persona_config: Option<&serde_json::Value>,
    previous_draft: Option<&BriefingDraft>,
    user_feedback: Option<&BriefingEdits>,
) -> Result<String, BriefingError> {
    let mut hb = handlebars::Handlebars::new();
    hb.set_strict_mode(false);
    hb.register_escape_fn(handlebars::no_escape);
    let ctx = BriefingPromptContext {
        user_description,
        briefing_depth,
        persona_config_json: persona_config
            .map(|v| serde_json::to_string_pretty(v).unwrap_or_default()),
        previous_draft: previous_draft.is_some(),
        previous_draft_json: previous_draft
            .map(|d| serde_json::to_string_pretty(d).unwrap_or_default()),
        user_feedback_json: user_feedback
            .map(|f| serde_json::to_string_pretty(f).unwrap_or_default()),
        general_notes: user_feedback
            .and_then(|f| f.general_notes.as_ref())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };
    hb.render_template(template, &ctx)
        .map_err(|e| BriefingError::Prompt(e.to_string()))
}

// ============================================================================
// JSON extraction
// ============================================================================

/// The model is instructed to emit JSON only. Real CLIs wrap text with prose,
/// chain-of-thought, or markdown fences. Codex with `--output-schema` is worse:
/// it emits a schema-conforming *stub* up front (all fields empty) before its
/// tool-call discovery phase, then the populated draft at the end. We can't
/// distinguish "stub" from "real" from text alone, so we scan for every
/// balanced top-level `{...}` object and return the longest one (the populated
/// draft will always dwarf the stub).
fn extract_json_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut best: Option<(usize, usize)> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        let mut depth = 0i32;
        let mut in_str = false;
        let mut escape = false;
        let mut end: Option<usize> = None;
        for (j, &b) in bytes.iter().enumerate().skip(i) {
            if in_str {
                if escape {
                    escape = false;
                } else if b == b'\\' {
                    escape = true;
                } else if b == b'"' {
                    in_str = false;
                }
                continue;
            }
            match b {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        match end {
            Some(j) => {
                let len = j - i + 1;
                if best.map(|(s, e)| (e - s + 1) < len).unwrap_or(true) {
                    best = Some((i, j));
                }
                // Continue past this object — siblings (other balanced objects
                // in the same stream) may be larger.
                i = j + 1;
            }
            None => break, // unmatched `{` — no more complete objects
        }
    }
    best.map(|(s, e)| &text[s..=e])
}

fn parse_json_value(raw: &str) -> Result<serde_json::Value, (String, String)> {
    let candidate = extract_json_object(raw).unwrap_or(raw);
    serde_json::from_str::<serde_json::Value>(candidate)
        .map_err(|e| (candidate.to_string(), e.to_string()))
}

// ============================================================================
// File path validation
// ============================================================================

pub fn validate_draft_paths(
    workspace_path: &Path,
    draft: &BriefingDraft,
) -> Vec<PathValidationResult> {
    let mut out = Vec::new();
    for task in &draft.tasks {
        for f in &task.relevant_files {
            let candidate = workspace_path.join(&f.path);
            out.push(PathValidationResult {
                task_id: task.id.clone(),
                path: f.path.clone(),
                exists: candidate.exists(),
            });
        }
    }
    out
}

// ============================================================================
// Task quality validation
// ============================================================================

fn is_meaningful_task_spec(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() < 12 {
        return false;
    }

    let normalized = trimmed
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>();
    !matches!(
        normalized.as_str(),
        "todo" | "tbd" | "na" | "none" | "acceptancecriteria"
    )
}

pub fn validate_task_quality(draft: &BriefingDraft, briefing_depth: &str) -> Vec<TaskQualityIssue> {
    let mut issues = Vec::new();
    let require_relevant_files = briefing_depth != "quick";

    if draft.tasks.is_empty() {
        issues.push(TaskQualityIssue {
            task_id: String::new(),
            task_title: String::new(),
            field: "tasks".into(),
            message: "Briefing draft must include at least one task.".into(),
        });
    }

    for task in &draft.tasks {
        let task_id = task.id.clone();
        let task_title = task.title.clone();

        if task.title.trim().is_empty() {
            issues.push(TaskQualityIssue {
                task_id: task_id.clone(),
                task_title: task_title.clone(),
                field: "title".into(),
                message: "Task title must be non-empty.".into(),
            });
        }

        if !is_meaningful_task_spec(&task.spec_markdown) {
            issues.push(TaskQualityIssue {
                task_id: task_id.clone(),
                task_title: task_title.clone(),
                field: "spec_markdown".into(),
                message: "Task spec_markdown must contain verifiable acceptance criteria.".into(),
            });
        }

        if require_relevant_files && task.relevant_files.is_empty() {
            issues.push(TaskQualityIssue {
                task_id: task_id.clone(),
                task_title: task_title.clone(),
                field: "relevant_files".into(),
                message: "This briefing depth requires at least one relevant file per task.".into(),
            });
        }

        for (index, file) in task.relevant_files.iter().enumerate() {
            if file.path.trim().is_empty() {
                issues.push(TaskQualityIssue {
                    task_id: task_id.clone(),
                    task_title: task_title.clone(),
                    field: format!("relevant_files[{index}].path"),
                    message: "Relevant file path must be non-empty.".into(),
                });
            }
            if file.reason.trim().is_empty() {
                issues.push(TaskQualityIssue {
                    task_id: task_id.clone(),
                    task_title: task_title.clone(),
                    field: format!("relevant_files[{index}].reason"),
                    message: "Relevant file reason must explain why the file matters.".into(),
                });
            }
        }
    }

    issues
}

pub fn format_task_quality_issues(issues: &[TaskQualityIssue]) -> String {
    issues
        .iter()
        .map(|issue| {
            format!(
                "{} {}: {}",
                issue.task_id,
                if issue.field.is_empty() {
                    "task"
                } else {
                    issue.field.as_str()
                },
                issue.message
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

// ============================================================================
// CLI invocation
// ============================================================================

/// Result of one generation attempt: parsed draft + the rendered prompt that produced it.
pub struct GenerationOutcome {
    pub draft: BriefingDraft,
    pub rendered_prompt: String,
    pub duration_ms: u64,
}

#[allow(dead_code)]
pub struct PromptJsonOutcome {
    pub json: serde_json::Value,
    pub rendered_prompt: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PersonaArtifact {
    pub persona_id: String,
    pub persona_label: String,
    pub provider: String,
    pub model: String,
    pub output: serde_json::Value,
    pub fallback_used: bool,
    pub warning: Option<String>,
    pub duration_ms: u64,
}

impl Serialize for PersonaArtifact {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("PersonaArtifact", 8)?;
        s.serialize_field("persona_id", &self.persona_id)?;
        s.serialize_field("persona_label", &self.persona_label)?;
        s.serialize_field("provider", &self.provider)?;
        s.serialize_field("model", &self.model)?;
        s.serialize_field("output", &self.output)?;
        s.serialize_field("fallback_used", &self.fallback_used)?;
        s.serialize_field("warning", &self.warning)?;
        s.serialize_field("duration_ms", &self.duration_ms)?;
        s.end()
    }
}

impl PersonaArtifact {
    pub fn mapping(&self) -> PersonaModelMapping {
        PersonaModelMapping {
            persona: self.persona_label.clone(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            fallback_used: self.fallback_used,
            warning: self.warning.clone(),
        }
    }
}

pub const PERSONA_INTENT_EXTRACTOR: &str = "intent_extractor";
pub const PERSONA_CODEBASE_CARTOGRAPHER: &str = "codebase_cartographer";
pub const PERSONA_AMBIGUITY_HUNTER: &str = "ambiguity_hunter";
pub const PERSONA_IMPLEMENTATION_PLANNER: &str = "implementation_planner";
pub const PERSONA_SKEPTIC: &str = "skeptic";
pub const PERSONA_FINAL_SYNTHESIZER: &str = "final_synthesizer";

pub fn persona_label(persona_id: &str) -> &'static str {
    match persona_id {
        PERSONA_INTENT_EXTRACTOR => "Intent Extractor",
        PERSONA_CODEBASE_CARTOGRAPHER => "Codebase Cartographer",
        PERSONA_AMBIGUITY_HUNTER => "Ambiguity Hunter",
        PERSONA_IMPLEMENTATION_PLANNER => "Implementation Planner",
        PERSONA_SKEPTIC => "Skeptic / Red-Team Reviewer",
        PERSONA_FINAL_SYNTHESIZER => "Final Synthesizer",
        _ => "Unknown Persona",
    }
}

pub fn personas_for_depth(depth: &str) -> Vec<&'static str> {
    match depth {
        "quick" => vec![PERSONA_INTENT_EXTRACTOR],
        "thorough" => vec![
            PERSONA_INTENT_EXTRACTOR,
            PERSONA_AMBIGUITY_HUNTER,
            PERSONA_IMPLEMENTATION_PLANNER,
            PERSONA_CODEBASE_CARTOGRAPHER,
        ],
        "adversarial" => vec![
            PERSONA_INTENT_EXTRACTOR,
            PERSONA_AMBIGUITY_HUNTER,
            PERSONA_IMPLEMENTATION_PLANNER,
            PERSONA_CODEBASE_CARTOGRAPHER,
            PERSONA_SKEPTIC,
        ],
        _ => vec![
            PERSONA_INTENT_EXTRACTOR,
            PERSONA_AMBIGUITY_HUNTER,
            PERSONA_IMPLEMENTATION_PLANNER,
        ],
    }
}

pub fn render_persona_prompt(
    persona_id: &str,
    user_description: &str,
    briefing_depth: &str,
    previous_draft: Option<&BriefingDraft>,
    user_feedback: Option<&BriefingEdits>,
    prior_artifacts: &[PersonaArtifact],
) -> String {
    let prior_artifacts_json = serde_json::to_string_pretty(prior_artifacts).unwrap_or_default();
    let previous_draft_json = previous_draft
        .map(|d| serde_json::to_string_pretty(d).unwrap_or_default())
        .unwrap_or_else(|| "null".to_string());
    let user_feedback_json = user_feedback
        .map(|f| serde_json::to_string_pretty(f).unwrap_or_default())
        .unwrap_or_else(|| "null".to_string());
    format!(
        r#"You are the {persona_label} in Orca's Requirements Distillation Lab.

This is not a chat interface. Produce one JSON object only, with no markdown fences and no prose outside JSON.

Briefing depth: {briefing_depth}

Your role:
{role}

Rules:
- Spend effort proportional to ambiguity and risk.
- Do not ask conversational follow-up questions.
- When something is unclear, encode it as structured fields or ambiguity ledger entries.
- Use prior persona artifacts as input, but do not blindly repeat them.
- If you inspect files, use targeted retrieval only and cite only files you actually considered.

Expected JSON shape:
{contract}

User feature description:
{user_description}

Previous draft JSON, if this is a refinement:
{previous_draft_json}

User edit/pushback JSON, if this is a refinement:
{user_feedback_json}

Prior persona artifacts from this run:
{prior_artifacts_json}
"#,
        persona_label = persona_label(persona_id),
        role = persona_role_description(persona_id),
        contract = persona_output_contract(persona_id),
    )
}

fn persona_role_description(persona_id: &str) -> &'static str {
    match persona_id {
        PERSONA_INTENT_EXTRACTOR => {
            "Turn the raw feature description into clear product intent: goal, user value, target users, workflows, explicit and implied requirements, non-goals, and success criteria."
        }
        PERSONA_CODEBASE_CARTOGRAPHER => {
            "Inspect the repository selectively and identify implementation-relevant context: likely touched areas, relevant files, patterns, APIs/hooks/components/services, affected tests, constraints, and unknowns."
        }
        PERSONA_AMBIGUITY_HUNTER => {
            "Find what an implementation agent may misunderstand. Produce a non-chat ambiguity ledger with recommended defaults and clear user-input-required flags."
        }
        PERSONA_IMPLEMENTATION_PLANNER => {
            "Convert the emerging brief into a safe implementation task graph with dependencies, file ownership, acceptance criteria, tests, risks, and parallelization guidance."
        }
        PERSONA_SKEPTIC => {
            "Attack the brief before task creation. Look for missing requirements, overbuilding, unsafe assumptions, security/privacy issues, UX edge cases, data migration risk, and test gaps."
        }
        _ => "Synthesize structured briefing artifacts.",
    }
}

pub fn render_final_synthesis_prompt(
    user_description: &str,
    briefing_depth: &str,
    persona_config: Option<&serde_json::Value>,
    previous_draft: Option<&BriefingDraft>,
    user_feedback: Option<&BriefingEdits>,
    persona_artifacts: &[PersonaArtifact],
) -> String {
    let persona_config_json = persona_config
        .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
        .unwrap_or_else(|| "null".to_string());
    let previous_draft_json = previous_draft
        .map(|d| serde_json::to_string_pretty(d).unwrap_or_default())
        .unwrap_or_else(|| "null".to_string());
    let user_feedback_json = user_feedback
        .map(|f| serde_json::to_string_pretty(f).unwrap_or_default())
        .unwrap_or_else(|| "null".to_string());
    let artifacts_json = serde_json::to_string_pretty(persona_artifacts).unwrap_or_default();
    format!(
        r#"You are the Final Synthesizer in Orca's Requirements Distillation Lab.

This product has no chat interface. Reconcile the specialist persona artifacts into one final structured briefing draft. Produce one JSON object only, with no markdown fences and no prose outside JSON.

Briefing depth: {briefing_depth}

Configured persona/provider/model mapping request:
{persona_config_json}

Synthesis rules:
- Preserve concrete user intent and imported tracker details.
- Use the ambiguity ledger instead of conversational questions.
- Mark readiness_status as:
  - ready_for_tasks when no required ambiguity is unresolved.
  - ready_with_assumptions when unresolved items can proceed if recommended assumptions are accepted.
  - blocked_needs_user_input when required unanswered decisions should block task creation.
- Build tasks that are independently executable and verifiable.
- Every task must include non-empty spec_markdown containing numbered, verifiable acceptance criteria for that task.
- For quick depth, relevant_files may be empty only when no reliable codebase context was gathered.
- For guided, thorough, and adversarial depths, every task must include at least one relevant_files item with path, certainty, and reason.
- Only include relevant files that a persona actually identified or that are strongly implied by the artifacts.
- Include persona_model_mapping from the actual artifact provider/model metadata.
- Do not invent separate model calls; only summarize the artifacts provided.

Required output schema is the BriefingDraft JSON shape:
{{
  "title": "Short feature title",
  "description": "Markdown description of the feature",
  "classification": {{
    "complexity": "low | medium | high",
    "ambiguity": "low | medium | high",
    "risk": "low | medium | high",
    "likely_touched_areas": ["area"],
    "recommended_depth": "quick | guided | thorough | adversarial",
    "repo_scanning_needed": true,
    "multi_model_critique_justified": false
  }},
  "budget_estimate": {{
    "depth": "quick | guided | thorough | adversarial",
    "cost_level": "low | medium | high",
    "risk_level": "low | medium | high",
    "confidence": 0.74,
    "token_strategy": "Why this depth is proportional",
    "expensive_steps": ["targeted repo retrieval"]
  }},
  "ambiguity_ledger": [],
  "structured_brief": {{
    "goal": "Goal",
    "user_value": "User value",
    "target_users": [],
    "non_goals": [],
    "codebase_context": "Relevant codebase summary",
    "relevant_files": [],
    "required_behavior": [],
    "ux_requirements": [],
    "data_api_requirements": [],
    "permissions_security": [],
    "edge_cases": [],
    "tests_required": [],
    "risks": [],
    "approved_assumptions": [],
    "open_questions": [],
    "task_graph": [],
    "acceptance_criteria": []
  }},
  "tasks": [
    {{
      "id": "task-1",
      "title": "Concrete implementation task",
      "spec_markdown": "1. Given ..., when ..., then ...\n2. Verify ...\n3. Tests cover ...",
      "relevant_files": [
        {{
          "path": "relative/path/from/repo/root.ts",
          "certainty": "Confirmed",
          "reason": "Why this file is likely touched or used as a pattern"
        }}
      ],
      "depends_on": []
    }}
  ],
  "assumptions": [],
  "approved_assumptions": [],
  "open_questions": [],
  "persona_model_mapping": [],
  "persona_artifacts": [],
  "readiness_status": "ready_for_tasks | ready_with_assumptions | blocked_needs_user_input",
  "confidence_score": 0.74,
  "recommended_depth": "guided"
}}

User feature description:
{user_description}

Previous draft JSON, if this is a refinement:
{previous_draft_json}

User edit/pushback JSON, if this is a refinement:
{user_feedback_json}

Specialist persona artifacts:
{artifacts_json}
"#,
    )
}

pub fn render_task_repair_prompt(
    user_description: &str,
    briefing_depth: &str,
    draft: &BriefingDraft,
    issues: &[TaskQualityIssue],
    persona_artifacts: &[PersonaArtifact],
) -> String {
    let draft_json = serde_json::to_string_pretty(draft).unwrap_or_default();
    let issues_json = serde_json::to_string_pretty(issues).unwrap_or_default();
    let artifacts_json = serde_json::to_string_pretty(persona_artifacts).unwrap_or_default();

    format!(
        r#"You are the Final Synthesizer in Orca's Requirements Distillation Lab.

The previous final draft was valid JSON but failed deterministic task quality validation. Return one repaired BriefingDraft JSON object only. No markdown fences and no prose outside JSON.

Repair constraints:
- Preserve the feature intent, task count, task ids, depends_on graph, assumptions, ambiguity ledger, structured_brief, classification, budget estimate, readiness_status, confidence_score, and recommended_depth unless a field is directly inconsistent with the task repairs.
- Only repair invalid task fields: title, spec_markdown, and relevant_files.
- Each task's spec_markdown must contain numbered, verifiable acceptance criteria for that task.
- For quick depth, relevant_files may remain empty only when the artifacts do not provide reliable file context.
- For guided, thorough, and adversarial depths, every task must include at least one relevant_files item with a non-empty path, certainty, and reason.
- Use relevant files from the persona artifacts when available. If a file is strongly implied but not confirmed, set certainty to "Candidate" and explain why.
- Do not add placeholder criteria or placeholder file paths.

Briefing depth: {briefing_depth}

Original user feature description:
{user_description}

Validation issues:
{issues_json}

Draft to repair:
{draft_json}

Specialist persona artifacts:
{artifacts_json}
"#,
    )
}

fn persona_output_contract(persona_id: &str) -> &'static str {
    match persona_id {
        PERSONA_INTENT_EXTRACTOR => {
            r#"{
  "goal": "string",
  "user_value": "string",
  "target_users": ["string"],
  "core_workflows": ["string"],
  "explicit_requirements": ["string"],
  "implied_requirements": ["string"],
  "non_goals": ["string"],
  "success_criteria": ["string"]
}"#
        }
        PERSONA_CODEBASE_CARTOGRAPHER => {
            r#"{
  "likely_touched_areas": ["string"],
  "relevant_files": [{"path":"string","certainty":"Confirmed | Candidate","reason":"string"}],
  "existing_patterns_to_reuse": ["string"],
  "apis_hooks_components_services": ["string"],
  "tests_likely_affected": ["string"],
  "architectural_constraints": ["string"],
  "unknowns_requiring_targeted_retrieval": ["string"]
}"#
        }
        PERSONA_AMBIGUITY_HUNTER => {
            r#"{
  "ambiguity_ledger": [{
    "id":"amb-1",
    "question":"string",
    "why_it_matters":"string",
    "risk_if_unanswered":"string",
    "recommended_default_assumption":"string",
    "user_input_required":true,
    "status":"unresolved | assumed | user_resolved",
    "user_answer":null
  }],
  "missing_decisions": ["string"],
  "conflicting_requirements": ["string"],
  "vague_terms": ["string"],
  "risky_assumptions": ["string"],
  "recommended_default_assumptions": ["string"]
}"#
        }
        PERSONA_IMPLEMENTATION_PLANNER => {
            r#"{
  "task_graph": ["task-1 -> task-2"],
  "task_dependencies": [{"task":"string","depends_on":["string"],"reason":"string"}],
  "suggested_file_ownership": [{"task":"string","files":["string"]}],
  "acceptance_criteria_per_task": [{"task":"string","criteria":["string"]}],
  "required_tests": ["string"],
  "execution_risks": ["string"],
  "parallelizable_work": ["string"],
  "sequential_work": ["string"]
}"#
        }
        PERSONA_SKEPTIC => {
            r#"{
  "missing_requirements": ["string"],
  "overbuilding_risks": ["string"],
  "unsafe_assumptions": ["string"],
  "security_privacy_concerns": ["string"],
  "ux_edge_cases": ["string"],
  "data_migration_risks": ["string"],
  "test_gaps": ["string"],
  "task_creation_recommendation": "allow | block",
  "recommendation_reason": "string"
}"#
        }
        _ => "{}",
    }
}

/// Run one briefing generation pass. Calls the CLI provider in `--print`-equivalent mode
/// (whatever `provider.build_invocation` resolves to), captures stdout, extracts the JSON
/// draft, and returns it. Retries once with a stricter suffix on parse failure.
///
/// The CWD for the subprocess is the workspace root.
pub async fn run_prompt_for_json(
    workspace_path: &Path,
    provider_path: &str,
    provider: &dyn Provider,
    model: &str,
    prompt: &str,
    output_schema: Option<serde_json::Value>,
    tracker: Arc<ChildTracker>,
    cancel: CancellationToken,
    live_output: Option<(AppHandle, String)>,
) -> Result<PromptJsonOutcome, BriefingError> {
    if !workspace_path.exists() {
        return Err(BriefingError::WorkspaceNotFound(
            workspace_path.display().to_string(),
        ));
    }

    let mut last_parse_err: Option<(String, String)> = None;
    for attempt in 0..2 {
        let rendered_prompt = if attempt == 0 {
            prompt.to_string()
        } else {
            format!(
                "{}\n\nIMPORTANT: respond with ONLY a JSON object matching the requested schema. \
                 No markdown fences, no prose, no explanation — JSON only.",
                prompt
            )
        };

        let mut options = build_provider_options(provider, model);
        if let Some(map) = options.as_object_mut() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(workspace_path.to_string_lossy().to_string()),
            );
            if provider.supports_structured_output() {
                if let Some(schema) = output_schema.clone() {
                    map.insert("output_schema".into(), schema);
                }
            }
        }
        let invocation = provider.build_invocation(&rendered_prompt, &options);

        let started = std::time::Instant::now();
        let collected = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let collected_cb = std::sync::Arc::clone(&collected);
        let pending_line = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let pending_line_cb = std::sync::Arc::clone(&pending_line);
        let provider_id_owned = provider.id().to_string();
        let live_output_cb = live_output.clone();

        let args_owned = invocation.args.clone();
        let args_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();

        let result = subprocess::run_streaming(
            provider_path,
            &args_refs,
            workspace_path,
            invocation.env.clone(),
            invocation.stdin.clone(),
            subprocess::StreamOptions::default(),
            cancel.clone(),
            &tracker,
            move |chunk| {
                if let Ok(mut g) = collected_cb.lock() {
                    g.push_str(&chunk.text);
                }
                if let Some((app, briefing_id)) = &live_output_cb {
                    forward_live_text(
                        app,
                        briefing_id,
                        &provider_id_owned,
                        &chunk.text,
                        &pending_line_cb,
                    );
                }
            },
        )
        .await
        .map_err(|e| BriefingError::CliInvocationFailed(e.to_string()))?;

        let raw = collected.lock().map(|g| g.clone()).unwrap_or_default();
        if result.exit_code != 0 {
            let output_tail = provider_failure_tail(&raw);
            let detail = if output_tail.is_empty() {
                format!("provider exited with code {}", result.exit_code)
            } else {
                format!(
                    "provider exited with code {}\n{}",
                    result.exit_code, output_tail
                )
            };
            return Err(BriefingError::CliInvocationFailed(detail));
        }

        let visible = collect_text_from_provider_stream(provider, &raw);
        match parse_json_value(&visible) {
            Ok(json) => {
                return Ok(PromptJsonOutcome {
                    json,
                    rendered_prompt,
                    duration_ms: started.elapsed().as_millis() as u64,
                });
            }
            Err(err) => {
                last_parse_err = Some(err);
            }
        }
    }

    let (output, error) = last_parse_err.unwrap_or_default();
    Err(BriefingError::ParseFailed {
        last_output: output,
        last_error: error,
    })
}

#[allow(dead_code)]
pub async fn run_briefing_generation(
    workspace_path: &Path,
    provider_path: &str,
    provider: &dyn Provider,
    model: &str,
    user_description: &str,
    briefing_depth: &str,
    persona_config: Option<&serde_json::Value>,
    previous_draft: Option<&BriefingDraft>,
    user_feedback: Option<&BriefingEdits>,
    tracker: Arc<ChildTracker>,
    cancel: CancellationToken,
    // Optional live-output sink. When `Some`, each provider-decoded text chunk
    // is forwarded as a `BRIEFING_CHUNK_EVENT` Tauri event so the UI can render
    // it live. Tests / non-Tauri callers pass None.
    live_output: Option<(AppHandle, String)>,
) -> Result<GenerationOutcome, BriefingError> {
    let template = resolve_briefing_prompt(workspace_path)?;
    let base_prompt = render_briefing_prompt(
        &template,
        user_description,
        briefing_depth,
        persona_config,
        previous_draft,
        user_feedback,
    )?;

    let outcome = run_prompt_for_json(
        workspace_path,
        provider_path,
        provider,
        model,
        &base_prompt,
        Some(briefing_draft_schema()),
        tracker,
        cancel,
        live_output,
    )
    .await?;
    let mut draft: BriefingDraft =
        serde_json::from_value(outcome.json.clone()).map_err(|e| BriefingError::ParseFailed {
            last_output: outcome.json.to_string(),
            last_error: e.to_string(),
        })?;
    ensure_draft_ids(&mut draft);
    Ok(GenerationOutcome {
        draft,
        rendered_prompt: outcome.rendered_prompt,
        duration_ms: outcome.duration_ms,
    })
}

/// Render a one-line, human-friendly summary of a tool-call's args. Picks the
/// "most identifying" field for common Claude tools (file_path, pattern,
/// command, …) and falls back to a truncated JSON dump. Kept short so the
/// live pane reads as a sequence of "→ Read(foo.ts)"-style lines rather than
/// a wall of structured args.
fn summarise_tool_args(args: &serde_json::Value) -> String {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return truncate_inline(&args.to_string()),
    };
    for key in [
        "file_path",
        "path",
        "pattern",
        "query",
        "command",
        "url",
        "todos",
    ] {
        if let Some(v) = obj.get(key).and_then(|x| x.as_str()) {
            return truncate_inline(v);
        }
    }
    // Generic object: show the first scalar value we find.
    for (_, v) in obj {
        if let Some(s) = v.as_str() {
            return truncate_inline(s);
        }
    }
    truncate_inline(&args.to_string())
}

fn truncate_inline(s: &str) -> String {
    let s = s.replace('\n', " ");
    if s.chars().count() > 80 {
        let trimmed: String = s.chars().take(77).collect();
        format!("{}…", trimmed)
    } else {
        s
    }
}

/// Append a streaming chunk to the per-attempt line buffer, drain any complete
/// lines through the provider's parser, and emit each resulting `TextChunk` to
/// the UI. For providers that don't emit JSONL we fall back to forwarding the
/// raw chunk so plain-text streams still reach the UI.
fn forward_live_text(
    app: &AppHandle,
    briefing_id: &str,
    provider_id: &str,
    chunk_text: &str,
    pending_line: &std::sync::Arc<std::sync::Mutex<String>>,
) {
    let provider = match crate::providers::get(provider_id) {
        Some(p) => p,
        None => return,
    };
    let mut emitted_any = false;
    if let Ok(mut buf) = pending_line.lock() {
        buf.push_str(chunk_text);
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line_trim = line.trim_end_matches('\n');
            for ev in provider.parse_line(line_trim) {
                let payload_text = match ev {
                    crate::providers::ProviderEvent::TextChunk(t) if !t.is_empty() => Some(t),
                    crate::providers::ProviderEvent::ToolCall { name, args } => {
                        Some(format!("\n→ {}({})\n", name, summarise_tool_args(&args)))
                    }
                    _ => None,
                };
                if let Some(t) = payload_text {
                    let _ = app.emit(
                        BRIEFING_CHUNK_EVENT,
                        BriefingChunkPayload {
                            briefing_id: briefing_id.to_string(),
                            text: t,
                        },
                    );
                    emitted_any = true;
                }
            }
        }
    }
    // Plain-text fallback: nothing parsed and the chunk has no newlines, so
    // forward verbatim. JSONL chunks are handled above; if a JSONL chunk arrived
    // without a trailing newline its text gets emitted on the next chunk that
    // closes the line.
    if !emitted_any && !chunk_text.is_empty() && !chunk_text.contains('\n') {
        let _ = app.emit(
            BRIEFING_CHUNK_EVENT,
            BriefingChunkPayload {
                briefing_id: briefing_id.to_string(),
                text: chunk_text.to_string(),
            },
        );
    }
}

/// Best-effort: feed each line through `provider.parse_line` and collect the text chunks.
/// Falls back to the raw blob if the provider produced nothing parseable (e.g. a plain
/// stdout-printing CLI). The combined text is what we hunt for JSON in.
fn collect_text_from_provider_stream(provider: &dyn Provider, raw: &str) -> String {
    let mut out = String::new();
    let mut any_parsed = false;
    for line in raw.lines() {
        for ev in provider.parse_line(line) {
            if let crate::providers::ProviderEvent::TextChunk(t) = ev {
                out.push_str(&t);
                any_parsed = true;
            }
        }
    }
    if any_parsed {
        out
    } else {
        raw.to_string()
    }
}

fn provider_failure_tail(raw: &str) -> String {
    const MAX_CHARS: usize = 4000;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let tail_reversed: String = trimmed.chars().rev().take(MAX_CHARS).collect();
    let tail: String = tail_reversed.chars().rev().collect();
    if tail.len() < trimmed.len() {
        format!("…{}", tail)
    } else {
        tail
    }
}

/// JSON Schema describing a `BriefingDraft`. Codex consumes this via
/// `--output-schema` to produce a JSON object that matches our deserializer
/// without resorting to "JSON only please" prompt tricks.
pub fn briefing_draft_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
            "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" },
            "tasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string", "minLength": 1 },
                        "spec_markdown": { "type": "string", "minLength": 1 },
                        "relevant_files": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "path": { "type": "string", "minLength": 1 },
                                    "certainty": { "type": "string", "enum": ["Confirmed", "Candidate"] },
                                    "reason": { "type": "string", "minLength": 1 }
                                }
                            }
                        },
                        "depends_on": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }
                }
            },
            "assumptions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "statement": { "type": "string" }
                    }
                }
            },
            "classification": { "type": ["object", "null"] },
            "budget_estimate": { "type": ["object", "null"] },
            "ambiguity_ledger": { "type": "array" },
            "structured_brief": { "type": ["object", "null"] },
            "approved_assumptions": { "type": "array", "items": { "type": "string" } },
            "open_questions": { "type": "array", "items": { "type": "string" } },
            "persona_model_mapping": { "type": "array" },
            "persona_artifacts": { "type": "array" },
            "readiness_status": { "type": ["string", "null"] },
            "confidence_score": { "type": ["number", "null"] },
            "recommended_depth": { "type": ["string", "null"] }
        }
    })
}

fn build_provider_options(provider: &dyn Provider, model: &str) -> serde_json::Value {
    let mut opts = provider.default_options();
    if let Some(map) = opts.as_object_mut() {
        if !model.is_empty() {
            map.insert("model".into(), serde_json::Value::String(model.into()));
        }
        // Briefings explore the codebase and produce structured JSON. We use
        // `acceptEdits` — same as the auditor — because `plan` mode reroutes the
        // model's answer through the ExitPlanMode tool call, which our text-stream
        // collector doesn't see, so the JSON never arrives. The prompt itself
        // never asks the model to edit anything; acceptEdits keeps the door open
        // for read tools (which the model needs) without the plan-mode side effect.
        map.insert(
            "permission_mode".into(),
            serde_json::Value::String("acceptEdits".into()),
        );
        // The Claude provider clamps `bypassPermissions` for the auditor by inspecting
        // `phase`; we reuse the same hint so the briefing inherits the read-only clamp.
        map.insert("phase".into(), serde_json::Value::String("auditor".into()));
    }
    opts
}

/// Models occasionally omit task ids or assumption ids; backfill ULIDs so the rest of
/// the system has stable references.
pub fn ensure_draft_ids(draft: &mut BriefingDraft) {
    let mut seen: HashMap<String, ()> = HashMap::new();
    for t in &mut draft.tasks {
        if t.id.trim().is_empty() || seen.contains_key(&t.id) {
            t.id = format!("dt_{}", ulid::Ulid::new());
        }
        seen.insert(t.id.clone(), ());
    }
    let mut seen_a: HashMap<String, ()> = HashMap::new();
    for a in &mut draft.assumptions {
        if a.id.trim().is_empty() || seen_a.contains_key(&a.id) {
            a.id = format!("da_{}", ulid::Ulid::new());
        }
        seen_a.insert(a.id.clone(), ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_draft() -> BriefingDraft {
        BriefingDraft {
            title: "T".into(),
            description: "D".into(),
            tasks: vec![DraftTask {
                id: "t1".into(),
                title: "first".into(),
                spec_markdown: "do it".into(),
                relevant_files: vec![RelevantFile {
                    path: "src/foo.ts".into(),
                    certainty: FileCertainty::Confirmed,
                    reason: "x".into(),
                }],
                depends_on: vec![],
            }],
            assumptions: vec![DraftAssumption {
                id: "a1".into(),
                statement: "x".into(),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn render_without_previous_draft_omits_block() {
        let template = include_str!("prompts/defaults/briefing.md");
        let out =
            render_briefing_prompt(template, "build a thing", "guided", None, None, None).unwrap();
        assert!(out.contains("build a thing"));
        assert!(!out.contains("Previous draft"));
    }

    #[test]
    fn render_with_previous_draft_includes_block() {
        let template = include_str!("prompts/defaults/briefing.md");
        let draft = sample_draft();
        let edits = BriefingEdits::default();
        let out = render_briefing_prompt(
            template,
            "build",
            "guided",
            None,
            Some(&draft),
            Some(&edits),
        )
        .unwrap();
        assert!(out.contains("Previous draft"));
        assert!(out.contains("first"));
    }

    #[test]
    fn extract_json_object_pulls_from_prose() {
        let raw = "Here is the plan:\n```json\n{\"title\":\"T\",\"tasks\":[]}\n```\nDone.";
        let extracted = extract_json_object(raw).unwrap();
        assert!(extracted.starts_with('{') && extracted.ends_with('}'));
        let v: serde_json::Value = serde_json::from_str(extracted).unwrap();
        assert_eq!(v["title"], "T");
    }

    #[test]
    fn extract_json_object_picks_largest_when_multiple_present() {
        // Codex with --output-schema emits an empty stub before its tool calls
        // and a populated draft after. Concatenated, both end up in the visible
        // text — we must pick the populated one.
        let stub = r#"{"assumptions":[],"description":"","tasks":[],"title":""}"#;
        let real = r#"{"title":"T","description":"D","tasks":[{"id":"t1","title":"first","spec_markdown":"do it","relevant_files":[]}],"assumptions":[]}"#;
        let combined = format!("{}{}", stub, real);
        let extracted = extract_json_object(&combined).unwrap();
        let v: serde_json::Value = serde_json::from_str(extracted).unwrap();
        assert_eq!(v["title"], "T");
        assert_eq!(v["tasks"][0]["id"], "t1");
    }

    #[test]
    fn extract_json_object_handles_nested_braces_and_strings() {
        let raw = r#"prefix {"a":"with } inside","b":{"c":1}} suffix"#;
        let extracted = extract_json_object(raw).unwrap();
        let v: serde_json::Value = serde_json::from_str(extracted).unwrap();
        assert_eq!(v["b"]["c"], 1);
    }

    #[test]
    fn draft_assumptions_accept_string_items() {
        let raw = r#"{
            "title": "T",
            "description": "D",
            "tasks": [],
            "assumptions": ["The loader returns countries with population numbers"]
        }"#;
        let mut draft: BriefingDraft = serde_json::from_str(raw).unwrap();
        ensure_draft_ids(&mut draft);
        assert_eq!(draft.assumptions.len(), 1);
        assert_eq!(
            draft.assumptions[0].statement,
            "The loader returns countries with population numbers"
        );
        assert!(!draft.assumptions[0].id.is_empty());
    }

    #[test]
    fn draft_persona_mapping_accepts_missing_persona() {
        let raw = r#"{
            "title": "T",
            "description": "D",
            "tasks": [],
            "assumptions": [],
            "persona_model_mapping": [
                { "provider": "codex", "model": "gpt-5.5" }
            ]
        }"#;
        let draft: BriefingDraft = serde_json::from_str(raw).unwrap();
        assert_eq!(draft.persona_model_mapping.len(), 1);
        assert_eq!(draft.persona_model_mapping[0].persona, "");
        assert_eq!(draft.persona_model_mapping[0].provider, "codex");
        assert_eq!(draft.persona_model_mapping[0].model, "gpt-5.5");
    }

    #[test]
    fn relevant_file_certainty_accepts_model_confidence_words() {
        let raw = r#"{
            "path": "src/feature.ts",
            "certainty": "High",
            "reason": "Likely touched by the feature"
        }"#;
        let file: RelevantFile = serde_json::from_str(raw).unwrap();
        assert_eq!(file.certainty, FileCertainty::Confirmed);

        let raw = r#"{
            "path": "src/feature.ts",
            "certainty": "Medium",
            "reason": "Possible pattern reference"
        }"#;
        let file: RelevantFile = serde_json::from_str(raw).unwrap();
        assert_eq!(file.certainty, FileCertainty::Candidate);
    }

    fn quality_task(spec_markdown: &str, relevant_files: Vec<RelevantFile>) -> DraftTask {
        DraftTask {
            id: "task-1".into(),
            title: "Implement the thing".into(),
            spec_markdown: spec_markdown.into(),
            relevant_files,
            depends_on: vec![],
        }
    }

    fn quality_file(reason: &str) -> RelevantFile {
        RelevantFile {
            path: "src/feature.ts".into(),
            certainty: FileCertainty::Confirmed,
            reason: reason.into(),
        }
    }

    #[test]
    fn task_quality_allows_quick_without_files_but_requires_spec() {
        let draft = BriefingDraft {
            tasks: vec![quality_task(
                "1. Given the feature is enabled, users can complete the flow.",
                vec![],
            )],
            ..Default::default()
        };

        assert!(validate_task_quality(&draft, "quick").is_empty());
    }

    #[test]
    fn task_quality_rejects_empty_task_list() {
        let draft = BriefingDraft::default();

        let issues = validate_task_quality(&draft, "guided");
        assert!(issues.iter().any(|issue| issue.field == "tasks"));
    }

    #[test]
    fn task_quality_rejects_empty_spec() {
        let draft = BriefingDraft {
            tasks: vec![quality_task(
                "",
                vec![quality_file("Implements the feature")],
            )],
            ..Default::default()
        };

        let issues = validate_task_quality(&draft, "guided");
        assert!(issues.iter().any(|issue| issue.field == "spec_markdown"));
    }

    #[test]
    fn task_quality_rejects_missing_files_for_guided_depth() {
        let draft = BriefingDraft {
            tasks: vec![quality_task(
                "1. Given the feature is enabled, users can complete the flow.",
                vec![],
            )],
            ..Default::default()
        };

        let issues = validate_task_quality(&draft, "guided");
        assert!(issues.iter().any(|issue| issue.field == "relevant_files"));
    }

    #[test]
    fn task_quality_rejects_file_without_reason() {
        let draft = BriefingDraft {
            tasks: vec![quality_task(
                "1. Given the feature is enabled, users can complete the flow.",
                vec![quality_file("")],
            )],
            ..Default::default()
        };

        let issues = validate_task_quality(&draft, "guided");
        assert!(issues
            .iter()
            .any(|issue| issue.field == "relevant_files[0].reason"));
    }

    #[test]
    fn validate_draft_paths_marks_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("real.txt"), "x").unwrap();
        let draft = BriefingDraft {
            title: "".into(),
            description: "".into(),
            assumptions: vec![],
            tasks: vec![DraftTask {
                id: "t".into(),
                title: "".into(),
                spec_markdown: "".into(),
                relevant_files: vec![
                    RelevantFile {
                        path: "real.txt".into(),
                        certainty: FileCertainty::Confirmed,
                        reason: "".into(),
                    },
                    RelevantFile {
                        path: "missing.txt".into(),
                        certainty: FileCertainty::Candidate,
                        reason: "".into(),
                    },
                ],
                depends_on: vec![],
            }],
            ..Default::default()
        };
        let results = validate_draft_paths(dir.path(), &draft);
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.path == "real.txt" && r.exists));
        assert!(results.iter().any(|r| r.path == "missing.txt" && !r.exists));
    }

    #[test]
    fn ensure_draft_ids_backfills_blank() {
        let mut draft = BriefingDraft {
            title: "".into(),
            description: "".into(),
            tasks: vec![DraftTask {
                id: "".into(),
                title: "".into(),
                spec_markdown: "".into(),
                relevant_files: vec![],
                depends_on: vec![],
            }],
            assumptions: vec![DraftAssumption {
                id: "".into(),
                statement: "".into(),
            }],
            ..Default::default()
        };
        ensure_draft_ids(&mut draft);
        assert!(!draft.tasks[0].id.is_empty());
        assert!(!draft.assumptions[0].id.is_empty());
    }
}
