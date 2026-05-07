//! Subprocess execution primitive. Streams stdout/stderr as buffered chunks via a
//! callback, supports cancellation, registers child PIDs in the global tracker so they
//! can be killed on app shutdown, and enforces non-interactive guarantees: stdin is
//! always closed (unless the caller supplies input), a baseline of non-interactive
//! environment variables is injected so tools that would otherwise prompt either fail
//! fast or pick safe defaults, and optional silence/wall-clock timeouts kill processes
//! that go silent or run too long.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct StreamChunk {
    pub kind: ChunkKind,
    pub text: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChunkKind {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessResult {
    pub exit_code: i32,
    pub duration_ms: u64,
}

/// Per-call knobs that aren't required for every subprocess. All fields default to
/// "no timeout"; callers opt in by supplying `Some(duration)`.
#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    /// If set, the process is killed when no stdout/stderr output arrives for this
    /// long. Resets every time the child writes anything.
    pub silence_timeout: Option<Duration>,
    /// If set, the process is killed when total elapsed time since spawn exceeds this.
    pub wall_clock_timeout: Option<Duration>,
}

#[derive(Debug, Error)]
pub enum SubprocessError {
    #[error("failed to spawn `{command}`: {source}")]
    SpawnFailed {
        command: String,
        #[source]
        source: std::io::Error,
    },

    #[error("subprocess cancelled by caller")]
    Cancelled,

    #[error("subprocess produced no output for {duration_ms}ms — killed")]
    StalledNoOutput { duration_ms: u64 },

    #[error("subprocess ran for {duration_ms}ms (wall-clock timeout) — killed")]
    StalledWallClock { duration_ms: u64 },

    #[error("subprocess io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Tracks live child PIDs so the Tauri shutdown hook can kill them.
pub struct ChildTracker(pub Mutex<HashMap<u32, ()>>);

impl ChildTracker {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    fn register(&self, pid: u32) {
        if let Ok(mut g) = self.0.lock() {
            g.insert(pid, ());
        }
    }

    fn unregister(&self, pid: u32) {
        if let Ok(mut g) = self.0.lock() {
            g.remove(&pid);
        }
    }

    pub fn kill_all(&self) {
        let pids: Vec<u32> = match self.0.lock() {
            Ok(g) => g.keys().copied().collect(),
            Err(_) => return,
        };
        for pid in pids {
            kill_pid(pid);
        }
    }
}

#[cfg(unix)]
fn kill_pid(pid: u32) {
    unsafe {
        // SIGKILL — shutdown is best-effort; we don't wait for graceful exit.
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .status();
}

/// Baseline non-interactive environment. Every spawned subprocess starts with these,
/// and the caller's `env` overrides any individual key. The goal is that any tool
/// which would otherwise prompt for input either errors immediately or proceeds with
/// a sensible default — the agent never silently hangs on an invisible TTY prompt.
pub fn default_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    // Generic CI signal — most package managers and test runners check this.
    env.insert("CI".into(), "true".into());
    // Debian-family installers shouldn't ever prompt.
    env.insert("DEBIAN_FRONTEND".into(), "noninteractive".into());
    // npm / pnpm: auto-accept install prompts.
    env.insert("NPM_CONFIG_YES".into(), "true".into());
    env.insert("npm_config_yes".into(), "true".into());
    // GitHub CLI: don't ever stop to ask the human.
    env.insert("GH_PROMPT_DISABLED".into(), "1".into());
    // git: refuse to prompt for credentials or open an editor.
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("GIT_ASKPASS".into(), "".into());
    env.insert("SSH_ASKPASS".into(), "".into());
    // Python: stream output and skip ancillary prompts/checks.
    env.insert("PYTHONUNBUFFERED".into(), "1".into());
    env.insert("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into());
    env.insert("PIP_NO_INPUT".into(), "1".into());
    env
}

/// Run a command, streaming stdout and stderr through `on_output` in chunks buffered
/// for roughly 50–100ms to keep event volume sane. Non-zero exit codes are not errors —
/// they are returned in `ProcessResult`. Spawn failure, cancellation, and stalls are.
///
/// Hardening guarantees:
/// - stdin is `Stdio::null()` unless `stdin_input` is `Some` (in which case the caller's
///   bytes are written and the pipe is closed, so the child still sees EOF promptly).
/// - `default_env()` is merged into the child's environment; `env` wins on conflict.
/// - No PTY is allocated; the child runs with plain pipes.
///
/// Stall guarantees (when the corresponding option is set):
/// - `silence_timeout` resets every time the child writes any output. If the timer
///   expires, the child is SIGKILLed and `StalledNoOutput` is returned.
/// - `wall_clock_timeout` is absolute from spawn time. Same kill behaviour, returning
///   `StalledWallClock`.
pub async fn run_streaming<F>(
    command: &str,
    args: &[&str],
    cwd: &Path,
    env: HashMap<String, String>,
    stdin_input: Option<String>,
    options: StreamOptions,
    cancel: CancellationToken,
    tracker: &ChildTracker,
    on_output: F,
) -> Result<ProcessResult, SubprocessError>
where
    F: Fn(StreamChunk) + Send + 'static,
{
    let started = Instant::now();

    let mut cmd = Command::new(command);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(if stdin_input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Defaults first, then per-call overrides — caller wins on conflict.
    for (k, v) in default_env() {
        cmd.env(k, v);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }

    let mut child = cmd.spawn().map_err(|e| SubprocessError::SpawnFailed {
        command: command.to_string(),
        source: e,
    })?;

    let pid = child.id().unwrap_or(0);
    if pid != 0 {
        tracker.register(pid);
    }

    if let (Some(text), Some(mut stdin)) = (stdin_input, child.stdin.take()) {
        let _ = stdin.write_all(text.as_bytes()).await;
        // Dropping stdin closes the pipe so the child sees EOF.
        drop(stdin);
    }

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Channel for raw line-level chunks coming off the child's pipes. We track the
    // most recent activity Instant for silence-timeout purposes by sniffing each
    // chunk before it goes to the user-supplied buffer task.
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamChunk>();

    let tx_out = tx.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let _ = tx_out.send(StreamChunk {
                        kind: ChunkKind::Stdout,
                        text,
                    });
                }
                Err(_) => break,
            }
        }
    });

    let tx_err = tx.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let _ = tx_err.send(StreamChunk {
                        kind: ChunkKind::Stderr,
                        text,
                    });
                }
                Err(_) => break,
            }
        }
    });
    drop(tx);

    // Last-activity clock, shared between the buffer task (which observes every
    // chunk) and the wait loop below (which polls it when the silence timer fires).
    // std::sync::Mutex is fine: contention is trivial and the critical section is a
    // single Instant assignment.
    let last_activity = std::sync::Arc::new(Mutex::new(Instant::now()));
    let last_activity_for_buf = std::sync::Arc::clone(&last_activity);

    // Buffer chunks for ~75ms before delivering to the caller. The window starts when
    // the first chunk in a batch arrives — continuous activity flushes every 75ms,
    // idle periods flush nothing.
    let buffer_window = Duration::from_millis(75);
    let buffer_task = tokio::spawn(async move {
        let mut pending_out = String::new();
        let mut pending_err = String::new();
        let flush = |kind: ChunkKind, text: &mut String, cb: &dyn Fn(StreamChunk)| {
            if !text.is_empty() {
                cb(StreamChunk {
                    kind,
                    text: std::mem::take(text),
                });
            }
        };
        let mut deadline: Option<Instant> = None;

        loop {
            let sleep_for = deadline.map(|d| d.saturating_duration_since(Instant::now()));
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(c) => {
                        if let Ok(mut g) = last_activity_for_buf.lock() {
                            *g = Instant::now();
                        }
                        match c.kind {
                            ChunkKind::Stdout => pending_out.push_str(&c.text),
                            ChunkKind::Stderr => pending_err.push_str(&c.text),
                        }
                        if deadline.is_none() {
                            deadline = Some(Instant::now() + buffer_window);
                        }
                    }
                    None => {
                        flush(ChunkKind::Stdout, &mut pending_out, &on_output);
                        flush(ChunkKind::Stderr, &mut pending_err, &on_output);
                        return;
                    }
                },
                _ = async {
                    match sleep_for {
                        Some(d) => tokio::time::sleep(d).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    flush(ChunkKind::Stdout, &mut pending_out, &on_output);
                    flush(ChunkKind::Stderr, &mut pending_err, &on_output);
                    deadline = None;
                }
            }
        }
    });

    // Resolution loop: race child completion against cancellation, silence timeout,
    // and wall-clock timeout. The timeouts are recomputed each iteration because the
    // silence deadline is dynamic (it slides forward as the child writes output).
    let stall_outcome = loop {
        let now = Instant::now();
        let silence_remaining: Option<Duration> = options.silence_timeout.map(|t| {
            let last = *last_activity.lock().unwrap_or_else(|e| e.into_inner());
            let elapsed_silence = now.saturating_duration_since(last);
            t.saturating_sub(elapsed_silence)
        });
        let wallclock_remaining: Option<Duration> = options
            .wall_clock_timeout
            .map(|t| t.saturating_sub(started.elapsed()));

        tokio::select! {
            // Bias towards process completion so a child that exits cleanly in the
            // same tick as a timeout fire is recorded as completed, not stalled.
            biased;
            status = child.wait() => {
                let status = status?;
                tracker.unregister(pid);
                let _ = buffer_task.await;
                break Ok(ProcessResult {
                    exit_code: status.code().unwrap_or(-1),
                    duration_ms: started.elapsed().as_millis() as u64,
                });
            }
            _ = cancel.cancelled() => {
                if let Some(p) = child.id() { kill_pid(p); }
                let _ = child.wait().await;
                tracker.unregister(pid);
                let _ = buffer_task.await;
                return Err(SubprocessError::Cancelled);
            }
            _ = sleep_opt(silence_remaining) => {
                // Re-check actual silence: a chunk might have arrived between the
                // remaining-time computation and the timer firing.
                let last = *last_activity.lock().unwrap_or_else(|e| e.into_inner());
                let elapsed_silence = Instant::now().saturating_duration_since(last);
                if let Some(t) = options.silence_timeout {
                    if elapsed_silence >= t {
                        if let Some(p) = child.id() { kill_pid(p); }
                        let _ = child.wait().await;
                        tracker.unregister(pid);
                        let _ = buffer_task.await;
                        break Err(SubprocessError::StalledNoOutput {
                            duration_ms: elapsed_silence.as_millis() as u64,
                        });
                    }
                }
                // Otherwise loop — silence_remaining will be recomputed.
            }
            _ = sleep_opt(wallclock_remaining) => {
                if let Some(p) = child.id() { kill_pid(p); }
                let _ = child.wait().await;
                tracker.unregister(pid);
                let _ = buffer_task.await;
                break Err(SubprocessError::StalledWallClock {
                    duration_ms: started.elapsed().as_millis() as u64,
                });
            }
        }
    };

    stall_outcome
}

/// Map a subprocess error to the `error_kind` string emitted on `PhaseRunFailed`.
/// Documented in `docs/events.md` alongside the other variants.
pub fn error_kind_for(err: &SubprocessError) -> &'static str {
    match err {
        SubprocessError::Cancelled => "user_cancelled",
        SubprocessError::StalledNoOutput { .. } => "stalled_no_output",
        SubprocessError::StalledWallClock { .. } => "stalled_wall_clock",
        SubprocessError::SpawnFailed { .. } | SubprocessError::Io(_) => "subprocess_error",
    }
}

/// Sleep for `Some(d)`, or wait forever if `None`. Used to make `select!` arms
/// conditional without proliferating branches.
async fn sleep_opt(d: Option<Duration>) {
    match d {
        Some(d) => tokio::time::sleep(d).await,
        None => std::future::pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    #[tokio::test]
    async fn streams_echo_output() {
        let tracker = ChildTracker::new();
        let collected = Arc::new(StdMutex::new(String::new()));
        let collected_cb = Arc::clone(&collected);

        let result = run_streaming(
            if cfg!(windows) { "cmd" } else { "echo" },
            if cfg!(windows) {
                &["/C", "echo hello"]
            } else {
                &["hello"]
            },
            Path::new("."),
            HashMap::new(),
            None,
            StreamOptions::default(),
            CancellationToken::new(),
            &tracker,
            move |chunk| {
                if let Ok(mut g) = collected_cb.lock() {
                    g.push_str(&chunk.text);
                }
            },
        )
        .await
        .expect("echo ran");

        assert_eq!(result.exit_code, 0);
        let out = collected.lock().unwrap().clone();
        assert!(
            out.contains("hello"),
            "expected 'hello' in output, got: {:?}",
            out
        );
    }

    /// Canary: if anyone wires `Stdio::inherit()` (or pipes a real value when the
    /// caller didn't ask) into the stdin slot, this test breaks. A subprocess that
    /// reads from stdin must see EOF immediately.
    #[cfg(unix)]
    #[tokio::test]
    async fn subprocess_cannot_read_from_stdin() {
        let tracker = ChildTracker::new();
        let collected = Arc::new(StdMutex::new(String::new()));
        let collected_cb = Arc::clone(&collected);

        let result = run_streaming(
            "sh",
            &[
                "-c",
                "if read line; then echo \"got: $line\"; else echo no_input; fi",
            ],
            Path::new("."),
            HashMap::new(),
            None,
            StreamOptions::default(),
            CancellationToken::new(),
            &tracker,
            move |chunk| {
                if let Ok(mut g) = collected_cb.lock() {
                    g.push_str(&chunk.text);
                }
            },
        )
        .await
        .expect("ran");

        assert_eq!(result.exit_code, 0);
        let out = collected.lock().unwrap().clone();
        assert!(
            out.contains("no_input"),
            "expected 'no_input' (EOF on stdin); got: {:?}",
            out
        );
    }

    /// Default env is set so a child can observe e.g. CI=true. This guards against
    /// regressions where the merge order is inverted or a key is dropped.
    #[cfg(unix)]
    #[tokio::test]
    async fn default_env_visible_to_child() {
        let tracker = ChildTracker::new();
        let collected = Arc::new(StdMutex::new(String::new()));
        let collected_cb = Arc::clone(&collected);

        run_streaming(
            "sh",
            &["-c", "echo ci=$CI git_prompt=$GIT_TERMINAL_PROMPT"],
            Path::new("."),
            HashMap::new(),
            None,
            StreamOptions::default(),
            CancellationToken::new(),
            &tracker,
            move |chunk| {
                if let Ok(mut g) = collected_cb.lock() {
                    g.push_str(&chunk.text);
                }
            },
        )
        .await
        .unwrap();

        let out = collected.lock().unwrap().clone();
        assert!(out.contains("ci=true"), "got: {:?}", out);
        assert!(out.contains("git_prompt=0"), "got: {:?}", out);
    }

    /// Caller-supplied env wins over defaults.
    #[cfg(unix)]
    #[tokio::test]
    async fn caller_env_overrides_default_env() {
        let tracker = ChildTracker::new();
        let collected = Arc::new(StdMutex::new(String::new()));
        let collected_cb = Arc::clone(&collected);

        let mut env = HashMap::new();
        env.insert("CI".into(), "false".into());

        run_streaming(
            "sh",
            &["-c", "echo ci=$CI"],
            Path::new("."),
            env,
            None,
            StreamOptions::default(),
            CancellationToken::new(),
            &tracker,
            move |chunk| {
                if let Ok(mut g) = collected_cb.lock() {
                    g.push_str(&chunk.text);
                }
            },
        )
        .await
        .unwrap();

        let out = collected.lock().unwrap().clone();
        assert!(out.contains("ci=false"), "got: {:?}", out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn silence_timeout_kills_quiet_subprocess() {
        let tracker = ChildTracker::new();
        let result = run_streaming(
            "sh",
            &["-c", "sleep 5"],
            Path::new("."),
            HashMap::new(),
            None,
            StreamOptions {
                silence_timeout: Some(Duration::from_millis(200)),
                wall_clock_timeout: None,
            },
            CancellationToken::new(),
            &tracker,
            |_| {},
        )
        .await;
        match result {
            Err(SubprocessError::StalledNoOutput { duration_ms }) => {
                assert!(duration_ms >= 200);
            }
            other => panic!("expected StalledNoOutput, got: {:?}", other),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn silence_timeout_resets_when_output_arrives() {
        // Child emits a heartbeat every 100ms for 600ms, then exits 0. With a 300ms
        // silence timeout the heartbeats keep it alive and we expect a clean exit.
        let tracker = ChildTracker::new();
        let result = run_streaming(
            "sh",
            &["-c", "for i in 1 2 3 4 5; do echo tick $i; sleep 0.1; done"],
            Path::new("."),
            HashMap::new(),
            None,
            StreamOptions {
                silence_timeout: Some(Duration::from_millis(300)),
                wall_clock_timeout: None,
            },
            CancellationToken::new(),
            &tracker,
            |_| {},
        )
        .await
        .expect("should not stall — heartbeats reset the silence timer");
        assert_eq!(result.exit_code, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wall_clock_timeout_kills_long_running_subprocess() {
        let tracker = ChildTracker::new();
        let result = run_streaming(
            "sh",
            &[
                "-c",
                // Constant chatter so the silence path can't be the one that fires.
                "while true; do echo tick; sleep 0.05; done",
            ],
            Path::new("."),
            HashMap::new(),
            None,
            StreamOptions {
                silence_timeout: None,
                wall_clock_timeout: Some(Duration::from_millis(300)),
            },
            CancellationToken::new(),
            &tracker,
            |_| {},
        )
        .await;
        match result {
            Err(SubprocessError::StalledWallClock { duration_ms }) => {
                assert!(duration_ms >= 300);
            }
            other => panic!("expected StalledWallClock, got: {:?}", other),
        }
    }
}
