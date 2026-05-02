//! Gate runner: shells out to a user-configured command in a worktree, captures combined
//! stdout/stderr output, and reports pass/fail by exit code. Tech-stack-agnostic — the app
//! treats the gate command as opaque and just checks its exit code.
//!
//! M7's pipeline orchestrator owns the decision to *run* a gate after a phase, and emits
//! the resulting `GateRan` event on the phase_run aggregate. This module just runs the
//! command and returns a `GateResult`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::subprocess::{self, ChildTracker, ChunkKind, SubprocessError};

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum GateError {
    #[error("failed to spawn gate `{name}`: {source}")]
    SpawnFailed {
        name: String,
        #[source]
        source: SubprocessError,
    },
    #[error("internal gate error: {0}")]
    Internal(String),
}

/// Outcome of running one gate. Pass/fail is purely the exit code (0 = pass).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct GateResult {
    pub gate_name: String,
    pub passed: bool,
    pub output: String,
    pub duration_ms: i64,
    pub exit_code: i32,
    pub timed_out: bool,
    /// Echoed straight onto the `GateRan` event by the caller.
    pub triggering_phase_run_id: String,
}

const OUTPUT_TRUNCATION_LIMIT: usize = 64 * 1024;

/// Run a gate command in `worktree_path` with the given timeout. The command is executed
/// via the platform shell (`sh -c` on Unix, `cmd /c` on Windows) so users can write
/// natural commands like `pnpm test && pnpm lint`.
///
/// Returns `Ok(GateResult)` for any subprocess outcome — including non-zero exit codes
/// and timeouts. Only spawn failure produces `Err`.
pub async fn run_gate(
    worktree_path: &Path,
    gate_name: &str,
    gate_command: &str,
    timeout: Duration,
    triggering_phase_run_id: &str,
    tracker: &ChildTracker,
) -> Result<GateResult, GateError> {
    let cancel = CancellationToken::new();
    let cancel_for_timer = cancel.clone();

    // Fire a timer that cancels the subprocess if it overruns. If the timer fires we mark
    // the gate as timed-out so the caller can surface that distinctly from a clean
    // non-zero exit.
    let timed_out = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let timed_out_for_timer = Arc::clone(&timed_out);
    let timer = tokio::spawn(async move {
        tokio::time::sleep(timeout).await;
        timed_out_for_timer.store(true, std::sync::atomic::Ordering::SeqCst);
        cancel_for_timer.cancel();
    });

    let output_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let output_for_cb = Arc::clone(&output_buf);

    let (cmd, args) = shell_command(gate_command);
    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let result = subprocess::run_streaming(
        &cmd,
        &args_refs,
        worktree_path,
        HashMap::new(),
        None,
        cancel,
        tracker,
        move |chunk| {
            // Both stdout and stderr go to the same combined buffer — gate output is
            // typically already mixed in test runners, and we want a single human-readable
            // log. ChunkKind is preserved here for future use (e.g. styling stderr in the
            // UI), but for now we just accumulate the text.
            let _ = chunk.kind; // keep variant import warning at bay
            if let Ok(mut buf) = output_for_cb.lock() {
                if buf.len() < OUTPUT_TRUNCATION_LIMIT {
                    buf.push_str(&chunk.text);
                }
            }
        },
    )
    .await;

    timer.abort();

    let timed_out_flag = timed_out.load(std::sync::atomic::Ordering::SeqCst);
    let mut output = output_buf
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    if output.len() >= OUTPUT_TRUNCATION_LIMIT {
        output.push_str(
            "\n...[gate output truncated; rerun the command in the worktree for the full \
             log]\n",
        );
    }

    match result {
        Ok(proc) => Ok(GateResult {
            gate_name: gate_name.to_string(),
            passed: !timed_out_flag && proc.exit_code == 0,
            output,
            duration_ms: proc.duration_ms as i64,
            exit_code: proc.exit_code,
            timed_out: timed_out_flag,
            triggering_phase_run_id: triggering_phase_run_id.to_string(),
        }),
        Err(SubprocessError::Cancelled) => {
            // Cancelled — almost always because the timer fired. Report as a timed-out,
            // failed gate so the orchestrator can stop the pipeline.
            let suffix = if timed_out_flag {
                format!(
                    "\n...[gate timed out after {}s]\n",
                    timeout.as_secs(),
                )
            } else {
                "\n...[gate cancelled]\n".to_string()
            };
            Ok(GateResult {
                gate_name: gate_name.to_string(),
                passed: false,
                output: output + &suffix,
                duration_ms: timeout.as_millis() as i64,
                exit_code: -1,
                timed_out: timed_out_flag,
                triggering_phase_run_id: triggering_phase_run_id.to_string(),
            })
        }
        Err(e) => Err(GateError::SpawnFailed {
            name: gate_name.to_string(),
            source: e,
        }),
    }
}

#[cfg(unix)]
fn shell_command(gate_command: &str) -> (String, Vec<String>) {
    ("sh".to_string(), vec!["-c".to_string(), gate_command.to_string()])
}

#[cfg(not(unix))]
fn shell_command(gate_command: &str) -> (String, Vec<String>) {
    (
        "cmd".to_string(),
        vec!["/C".to_string(), gate_command.to_string()],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn passing_gate_reports_passed_zero_exit() {
        let dir = TempDir::new().unwrap();
        let tracker = ChildTracker::new();
        let r = run_gate(
            dir.path(),
            "echo_ok",
            "echo hello",
            Duration::from_secs(5),
            "pr_test",
            &tracker,
        )
        .await
        .unwrap();
        assert!(r.passed);
        assert_eq!(r.exit_code, 0);
        assert!(!r.timed_out);
        assert!(r.output.contains("hello"));
        assert_eq!(r.gate_name, "echo_ok");
        assert_eq!(r.triggering_phase_run_id, "pr_test");
    }

    #[tokio::test]
    async fn failing_gate_reports_passed_false() {
        let dir = TempDir::new().unwrap();
        let tracker = ChildTracker::new();
        let r = run_gate(
            dir.path(),
            "exit_fail",
            "exit 7",
            Duration::from_secs(5),
            "pr_test",
            &tracker,
        )
        .await
        .unwrap();
        assert!(!r.passed);
        assert_eq!(r.exit_code, 7);
        assert!(!r.timed_out);
    }

    #[tokio::test]
    async fn gate_chains_via_shell() {
        // The brief explicitly wants user-natural shell commands, including && and pipes.
        let dir = TempDir::new().unwrap();
        let tracker = ChildTracker::new();
        let r = run_gate(
            dir.path(),
            "chain",
            "echo first && echo second",
            Duration::from_secs(5),
            "pr_test",
            &tracker,
        )
        .await
        .unwrap();
        assert!(r.passed);
        assert!(r.output.contains("first"));
        assert!(r.output.contains("second"));
    }

    #[tokio::test]
    async fn gate_timeout_is_reported() {
        let dir = TempDir::new().unwrap();
        let tracker = ChildTracker::new();
        let r = run_gate(
            dir.path(),
            "slow",
            "sleep 10",
            Duration::from_millis(200),
            "pr_test",
            &tracker,
        )
        .await
        .unwrap();
        assert!(!r.passed);
        assert!(r.timed_out);
        assert!(r.output.contains("timed out"));
    }
}
