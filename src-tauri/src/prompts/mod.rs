//! Prompt resolution, templating, and content hashing.
//!
//! Resolution order: a workspace-level customised file at
//! `<workspace>/.orca/prompts/{phase}.md` wins; otherwise the bundled default for
//! that phase is returned. Rendering is Handlebars; the resulting hash is recorded on
//! `PhaseRunStarted` as `prompt_template_hash` so a phase run is reproducible from its
//! event log.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use handlebars::Handlebars;
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::briefing::{FileCertainty, RelevantFile};
use crate::settings::PhaseType;

const BUNDLED_TEST_AUTHOR: &str = include_str!("defaults/test_author.md");
const BUNDLED_IMPLEMENTER: &str = include_str!("defaults/implementer.md");
const BUNDLED_AUDITOR: &str = include_str!("defaults/auditor.md");

#[derive(Debug, Error)]
pub enum PromptError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("template render failed: {0}")]
    Render(String),
}

/// Variables exposed to every phase prompt. Fields the phase doesn't need are still
/// present (Handlebars ignores unused vars), so a single context type works for all
/// phases. The auditor is the only consumer of `git_diff`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PromptContext {
    pub task_title: String,
    pub task_spec_markdown: String,
    pub acceptance_criteria: String,
    pub prior_phase_commits: HashMap<String, String>,
    pub git_diff: Option<String>,
    pub is_retry: bool,
    /// Legacy / fallback: a single pre-formatted retry block. Set when the caller had
    /// nothing structured to pass — the bundled prompt prefers the structured fields
    /// below when available.
    pub retry_context: Option<String>,
    /// Pre-formatted bullet list of the auditor's concerns (severity, category, anchor,
    /// rationale), suitable for direct inclusion in a markdown prompt section.
    pub retry_auditor_block: Option<String>,
    /// Free-text feedback the user typed when passing back to the implementer.
    pub retry_user_feedback: Option<String>,
    /// Files the briefing flow flagged as likely targets for the task. Empty for
    /// tasks created via the quick-task shortcut or other paths without file
    /// awareness; the implementer template renders nothing in that case.
    #[serde(default)]
    pub relevant_files: Vec<RelevantFileForPrompt>,
}

/// Template-friendly view of `RelevantFile`. Carries `is_candidate` derived from
/// `certainty` so the bundled implementer prompt can branch on it without needing a
/// custom Handlebars `eq` helper. Construct via `From<&RelevantFile>`.
#[derive(Debug, Clone, Serialize)]
pub struct RelevantFileForPrompt {
    pub path: String,
    pub reason: String,
    pub is_candidate: bool,
}

impl From<&RelevantFile> for RelevantFileForPrompt {
    fn from(f: &RelevantFile) -> Self {
        Self {
            path: f.path.clone(),
            reason: f.reason.clone(),
            is_candidate: matches!(f.certainty, FileCertainty::Candidate),
        }
    }
}

/// Convenience: convert a `serde_json::Value` (typically `task_projection.relevant_files`)
/// into the template-friendly form. Returns an empty vec on any parse failure so a malformed
/// projection row never blocks a phase from running.
pub fn relevant_files_from_value(v: &serde_json::Value) -> Vec<RelevantFileForPrompt> {
    serde_json::from_value::<Vec<RelevantFile>>(v.clone())
        .ok()
        .map(|files| files.iter().map(RelevantFileForPrompt::from).collect())
        .unwrap_or_default()
}

/// The path a customised prompt file would live at, regardless of whether it exists.
pub fn prompt_file_path(workspace_path: &Path, phase: PhaseType) -> PathBuf {
    workspace_path
        .join(crate::workspace_db::WORKSPACE_DIR)
        .join("prompts")
        .join(format!("{}.md", phase.as_str()))
}

/// Bundled default prompt for a phase. Compiled into the binary via `include_str!`.
pub fn bundled_default(phase: PhaseType) -> &'static str {
    match phase {
        PhaseType::TestAuthor => BUNDLED_TEST_AUTHOR,
        PhaseType::Implementer => BUNDLED_IMPLEMENTER,
        PhaseType::Auditor => BUNDLED_AUDITOR,
    }
}

/// Read the resolved prompt template for a phase. If the workspace has a customised
/// file, return its contents; otherwise return the bundled default.
pub fn resolve(workspace_path: &Path, phase: PhaseType) -> Result<String, PromptError> {
    let path = prompt_file_path(workspace_path, phase);
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(bundled_default(phase).to_string()),
        Err(e) => Err(e.into()),
    }
}

/// Whether the workspace has a customised prompt file for this phase on disk.
pub fn is_customised(workspace_path: &Path, phase: PhaseType) -> bool {
    prompt_file_path(workspace_path, phase).is_file()
}

/// Render a Handlebars template with the given context.
pub fn render(template: &str, context: &PromptContext) -> Result<String, PromptError> {
    let mut hb = Handlebars::new();
    hb.set_strict_mode(false);
    hb.register_escape_fn(handlebars::no_escape);
    hb.render_template(template, context)
        .map_err(|e| PromptError::Render(e.to_string()))
}

/// Lowercase hex SHA-256 of the rendered prompt content.
pub fn hash(rendered: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(rendered.as_bytes());
    let digest = hasher.finalize();
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// Write a customised prompt to disk. Creates the prompts dir if needed.
pub fn save(workspace_path: &Path, phase: PhaseType, content: &str) -> Result<(), PromptError> {
    let path = prompt_file_path(workspace_path, phase);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)?;
    Ok(())
}

/// Delete a customised prompt file so the next read returns the bundled default. A
/// missing file is not an error — `reset_prompt` should be idempotent.
pub fn reset(workspace_path: &Path, phase: PhaseType) -> Result<(), PromptError> {
    let path = prompt_file_path(workspace_path, phase);
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Ensure `<workspace>/.orca/prompts/` exists. Called from workspace activation so the
/// directory is always present once a workspace has been opened.
pub fn ensure_prompts_dir(workspace_path: &Path) -> std::io::Result<()> {
    let dir = workspace_path
        .join(crate::workspace_db::WORKSPACE_DIR)
        .join("prompts");
    std::fs::create_dir_all(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ctx() -> PromptContext {
        let mut prior = HashMap::new();
        prior.insert("test_author".into(), "abc123".into());
        PromptContext {
            task_title: "Add foo to bar".into(),
            task_spec_markdown: "spec".into(),
            acceptance_criteria: "- it works".into(),
            prior_phase_commits: prior,
            git_diff: Some("diff --git a/x b/x\n".into()),
            is_retry: true,
            retry_context: Some("- be more careful".into()),
            retry_auditor_block: None,
            retry_user_feedback: None,
            relevant_files: vec![],
        }
    }

    #[test]
    fn render_substitutes_variables() {
        let out = render("title: {{task_title}}", &ctx()).unwrap();
        assert_eq!(out, "title: Add foo to bar");
    }

    #[test]
    fn render_handles_if_blocks() {
        let tmpl = "{{#if is_retry}}retry: {{retry_context}}{{/if}}";
        let out = render(tmpl, &ctx()).unwrap();
        assert_eq!(out, "retry: - be more careful");
    }

    #[test]
    fn render_resolves_nested_prior_phase_commits() {
        let tmpl = "{{#if prior_phase_commits.test_author}}sha={{prior_phase_commits.test_author}}{{/if}}";
        let out = render(tmpl, &ctx()).unwrap();
        assert_eq!(out, "sha=abc123");
    }

    #[test]
    fn render_no_escape_for_diff_markdown() {
        // The auditor's git_diff often contains `<` `>` `&`. We don't want HTML escaping.
        let mut c = ctx();
        c.git_diff = Some("<x> & <y>".into());
        let out = render("diff: {{git_diff}}", &c).unwrap();
        assert_eq!(out, "diff: <x> & <y>");
    }

    #[test]
    fn render_full_implementer_template() {
        let out = render(BUNDLED_IMPLEMENTER, &ctx()).unwrap();
        assert!(out.contains("Add foo to bar"));
        assert!(out.contains("abc123"));
        assert!(out.contains("- be more careful"));
        assert!(out.contains("- it works"));
    }

    #[test]
    fn render_implementer_omits_relevant_files_section_when_empty() {
        let out = render(BUNDLED_IMPLEMENTER, &ctx()).unwrap();
        assert!(!out.contains("Likely files to touch"));
    }

    #[test]
    fn render_implementer_includes_relevant_files_with_candidate_marker() {
        let mut c = ctx();
        c.relevant_files = vec![
            RelevantFileForPrompt {
                path: "src/foo.ts".into(),
                reason: "contains the X logic".into(),
                is_candidate: false,
            },
            RelevantFileForPrompt {
                path: "src/bar.ts".into(),
                reason: "suspected".into(),
                is_candidate: true,
            },
        ];
        let out = render(BUNDLED_IMPLEMENTER, &c).unwrap();
        assert!(out.contains("Likely files to touch"));
        assert!(out.contains("`src/foo.ts` — contains the X logic"));
        // Confirmed file gets no candidate marker.
        let foo_line = out
            .lines()
            .find(|l| l.contains("src/foo.ts"))
            .expect("foo line");
        assert!(!foo_line.contains("candidate"));
        // Candidate file is marked.
        let bar_line = out
            .lines()
            .find(|l| l.contains("src/bar.ts"))
            .expect("bar line");
        assert!(bar_line.contains("*(candidate)*"));
    }

    #[test]
    fn relevant_files_from_value_returns_empty_on_garbage() {
        let v = serde_json::json!("not an array");
        assert!(relevant_files_from_value(&v).is_empty());
    }

    #[test]
    fn relevant_files_from_value_parses_array_of_relevant_file() {
        let v = serde_json::json!([
            { "path": "a.rs", "certainty": "Confirmed", "reason": "r1" },
            { "path": "b.rs", "certainty": "Candidate", "reason": "r2" },
        ]);
        let out = relevant_files_from_value(&v);
        assert_eq!(out.len(), 2);
        assert!(!out[0].is_candidate);
        assert!(out[1].is_candidate);
    }

    #[test]
    fn render_full_auditor_template_includes_diff() {
        let out = render(BUNDLED_AUDITOR, &ctx()).unwrap();
        assert!(out.contains("diff --git a/x b/x"));
        assert!(out.contains("- it works"));
    }

    #[test]
    fn hash_is_stable_and_unique() {
        let h1 = hash("hello");
        let h2 = hash("hello");
        let h3 = hash("hello!");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
        assert_eq!(h1.len(), 64);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn resolve_returns_bundled_when_no_file() {
        let dir = TempDir::new().unwrap();
        let out = resolve(dir.path(), PhaseType::Implementer).unwrap();
        assert_eq!(out, BUNDLED_IMPLEMENTER);
        assert!(!is_customised(dir.path(), PhaseType::Implementer));
    }

    #[test]
    fn save_then_resolve_returns_customised() {
        let dir = TempDir::new().unwrap();
        save(dir.path(), PhaseType::Implementer, "custom prompt").unwrap();
        assert!(is_customised(dir.path(), PhaseType::Implementer));
        let out = resolve(dir.path(), PhaseType::Implementer).unwrap();
        assert_eq!(out, "custom prompt");
    }

    #[test]
    fn reset_removes_file_and_falls_back_to_default() {
        let dir = TempDir::new().unwrap();
        save(dir.path(), PhaseType::Auditor, "x").unwrap();
        reset(dir.path(), PhaseType::Auditor).unwrap();
        assert!(!is_customised(dir.path(), PhaseType::Auditor));
        let out = resolve(dir.path(), PhaseType::Auditor).unwrap();
        assert_eq!(out, BUNDLED_AUDITOR);
    }

    #[test]
    fn reset_is_idempotent_when_no_file() {
        let dir = TempDir::new().unwrap();
        // Should not error when nothing to remove.
        reset(dir.path(), PhaseType::TestAuthor).unwrap();
    }

    #[test]
    fn defaults_are_nonempty_for_all_phases() {
        for p in [PhaseType::TestAuthor, PhaseType::Implementer, PhaseType::Auditor] {
            assert!(!bundled_default(p).is_empty());
        }
    }
}
