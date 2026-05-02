//! Subprocess execution primitive. Streams stdout/stderr as buffered chunks via a
//! callback, supports cancellation, and registers child PIDs in the global tracker so
//! they can be killed on app shutdown.

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

/// Run a command, streaming stdout and stderr through `on_output` in chunks buffered for
/// roughly 50–100ms to keep event volume sane. Non-zero exit codes are not errors — they
/// are returned in `ProcessResult`. Spawn failure and cancellation are.
pub async fn run_streaming<F>(
    command: &str,
    args: &[&str],
    cwd: &Path,
    env: HashMap<String, String>,
    stdin_input: Option<String>,
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

    // Buffer chunks for ~75ms before delivering to the caller. The window starts when the
    // first chunk in a batch arrives — continuous activity flushes every 75ms, idle
    // periods flush nothing.
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

    let exit_status = tokio::select! {
        status = child.wait() => status?,
        _ = cancel.cancelled() => {
            if let Some(pid) = child.id() {
                kill_pid(pid);
            }
            let _ = child.wait().await;
            tracker.unregister(pid);
            let _ = buffer_task.await;
            return Err(SubprocessError::Cancelled);
        }
    };

    tracker.unregister(pid);
    let _ = buffer_task.await;

    Ok(ProcessResult {
        exit_code: exit_status.code().unwrap_or(-1),
        duration_ms: started.elapsed().as_millis() as u64,
    })
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
            if cfg!(windows) { &["/C", "echo hello"] } else { &["hello"] },
            Path::new("."),
            HashMap::new(),
            None,
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
        assert!(out.contains("hello"), "expected 'hello' in output, got: {:?}", out);
    }
}
