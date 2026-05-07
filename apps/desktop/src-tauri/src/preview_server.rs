use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::Serialize;

use crate::settings::PreviewServerSettings;

const MAX_LOG_LINES: usize = 400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewServerState {
    Idle,
    Starting,
    Running,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewServerStatus {
    pub state: PreviewServerState,
    pub task_id: Option<String>,
    pub worktree_path: Option<String>,
    pub base_url: Option<String>,
    pub route_path: Option<String>,
    pub open_url: Option<String>,
    pub started_at: Option<u64>,
    pub last_error: Option<String>,
    pub logs: Vec<String>,
}

impl Default for PreviewServerStatus {
    fn default() -> Self {
        Self {
            state: PreviewServerState::Idle,
            task_id: None,
            worktree_path: None,
            base_url: None,
            route_path: None,
            open_url: None,
            started_at: None,
            last_error: None,
            logs: Vec::new(),
        }
    }
}

struct Inner {
    status: PreviewServerStatus,
    logs: VecDeque<String>,
    child: Option<Child>,
}

pub struct PreviewServerManager {
    inner: Arc<Mutex<Inner>>,
}

impl PreviewServerManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                status: PreviewServerStatus::default(),
                logs: VecDeque::new(),
                child: None,
            })),
        }
    }

    pub fn status(&self) -> PreviewServerStatus {
        let mut inner = self.inner.lock().expect("preview server mutex poisoned");
        refresh_child_state(&mut inner);
        snapshot(&inner)
    }

    pub async fn start(
        &self,
        task_id: String,
        worktree_path: String,
        settings: PreviewServerSettings,
        env: HashMap<String, String>,
        route_path: String,
    ) -> Result<PreviewServerStatus, String> {
        let command = settings
            .command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "preview server command is not configured".to_string())?
            .to_string();
        if !settings.enabled {
            return Err("preview server is disabled for this workspace".into());
        }

        let base_url = normalize_base_url(&settings.base_url);
        let health_path = normalize_path(&settings.health_path);
        let route_path = normalize_path(&route_path);
        let open_url = combine_url(&base_url, &route_path);
        let health_url = combine_url(&base_url, &health_path);

        {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            refresh_child_state(&mut inner);
            if let Some(owner) = inner.status.task_id.as_deref() {
                if owner == task_id && matches!(inner.status.state, PreviewServerState::Running) {
                    inner.status.route_path = Some(route_path);
                    inner.status.open_url = Some(open_url);
                    return Ok(snapshot(&inner));
                }
                if matches!(
                    inner.status.state,
                    PreviewServerState::Starting | PreviewServerState::Running
                ) {
                    return Err(format!(
                        "preview server is already running for task {}",
                        owner
                    ));
                }
            }
            clear_process(&mut inner);
            inner.status = PreviewServerStatus {
                state: PreviewServerState::Starting,
                task_id: Some(task_id.clone()),
                worktree_path: Some(worktree_path.clone()),
                base_url: Some(base_url.clone()),
                route_path: Some(route_path.clone()),
                open_url: Some(open_url.clone()),
                started_at: Some(now_millis()),
                last_error: None,
                logs: Vec::new(),
            };
            inner.logs.clear();
        }

        let mut child = spawn_shell_command(&command, Path::new(&worktree_path), env)
            .map_err(|e| self.fail(format!("failed to start preview server: {}", e)))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.child = Some(child);
        }

        if let Some(out) = stdout {
            self.spawn_log_reader("stdout", out);
        }
        if let Some(err) = stderr {
            self.spawn_log_reader("stderr", err);
        }

        match self
            .wait_until_ready(
                &health_url,
                Duration::from_secs(settings.startup_timeout_seconds.max(1)),
            )
            .await
        {
            ReadyOutcome::Ready => {
                let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
                refresh_child_state(&mut inner);
                if !matches!(inner.status.state, PreviewServerState::Failed) {
                    inner.status.state = PreviewServerState::Running;
                    inner.status.last_error = None;
                }
                Ok(snapshot(&inner))
            }
            ReadyOutcome::Stopped => Ok(self.status()),
            ReadyOutcome::Failed(err) => Err(self.fail(err)),
        }
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().expect("preview server mutex poisoned");
        clear_process(&mut inner);
        inner.status = PreviewServerStatus::default();
        inner.logs.clear();
    }

    fn fail(&self, error: String) -> String {
        let mut inner = self.inner.lock().expect("preview server mutex poisoned");
        clear_process(&mut inner);
        inner.status.state = PreviewServerState::Failed;
        inner.status.last_error = Some(error.clone());
        push_log(&mut inner, format!("[preview] {}", error));
        error
    }

    fn spawn_log_reader<R>(&self, stream: &'static str, reader: R)
    where
        R: std::io::Read + Send + 'static,
    {
        let inner_lock = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            let reader = BufReader::new(reader);
            for line in reader.lines() {
                let text = match line {
                    Ok(line) => line,
                    Err(e) => format!("failed reading {}: {}", stream, e),
                };
                if let Ok(mut inner) = inner_lock.lock() {
                    push_log(&mut inner, format!("[{}] {}", stream, text));
                }
            }
        });
    }

    async fn wait_until_ready(&self, url: &str, timeout: Duration) -> ReadyOutcome {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(client) => client,
            Err(e) => {
                return ReadyOutcome::Failed(format!(
                    "failed to create preview health client: {}",
                    e
                ));
            }
        };
        let deadline = std::time::Instant::now() + timeout;

        loop {
            {
                let mut inner = match self.inner.lock() {
                    Ok(inner) => inner,
                    Err(e) => return ReadyOutcome::Failed(e.to_string()),
                };
                refresh_child_state(&mut inner);
                if matches!(inner.status.state, PreviewServerState::Idle) {
                    return ReadyOutcome::Stopped;
                }
                if matches!(inner.status.state, PreviewServerState::Failed) {
                    return ReadyOutcome::Failed(
                        inner.status.last_error.clone().unwrap_or_else(|| {
                            "preview server exited before becoming ready".into()
                        }),
                    );
                }
            }

            match client.get(url).send().await {
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    if (200..=499).contains(&code) {
                        return ReadyOutcome::Ready;
                    }
                    return ReadyOutcome::Failed(format!(
                        "preview server health check returned HTTP {} at {}",
                        code, url
                    ));
                }
                Err(e) => {
                    if std::time::Instant::now() >= deadline {
                        return ReadyOutcome::Failed(format!(
                            "preview server did not become ready at {} within {}s: {}",
                            url,
                            timeout.as_secs(),
                            e
                        ));
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

enum ReadyOutcome {
    Ready,
    Stopped,
    Failed(String),
}

fn snapshot(inner: &Inner) -> PreviewServerStatus {
    let mut status = inner.status.clone();
    status.logs = inner.logs.iter().cloned().collect();
    status
}

fn push_log(inner: &mut Inner, line: String) {
    if inner.logs.len() >= MAX_LOG_LINES {
        inner.logs.pop_front();
    }
    inner.logs.push_back(line);
}

fn refresh_child_state(inner: &mut Inner) {
    let Some(child) = inner.child.as_mut() else {
        return;
    };
    match child.try_wait() {
        Ok(Some(status)) => {
            inner.child = None;
            if !matches!(inner.status.state, PreviewServerState::Idle) {
                inner.status.state = PreviewServerState::Failed;
                inner.status.last_error =
                    Some(format!("preview server exited with status {}", status));
                push_log(
                    inner,
                    format!("[preview] preview server exited with status {}", status),
                );
            }
        }
        Ok(None) => {}
        Err(e) => {
            inner.status.state = PreviewServerState::Failed;
            inner.status.last_error = Some(format!("failed to inspect preview server: {}", e));
        }
    }
}

fn clear_process(inner: &mut Inner) {
    if let Some(mut child) = inner.child.take() {
        kill_child_tree(&mut child);
        let _ = child.wait();
    }
}

#[cfg(unix)]
fn kill_child_tree(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        // Negative PID targets the process group created for the preview shell. This
        // catches package-manager wrappers and the actual dev server child process.
        libc::kill(-pid, libc::SIGTERM);
    }
    std::thread::sleep(Duration::from_millis(250));
    if matches!(child.try_wait(), Ok(None)) {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_child_tree(child: &mut Child) {
    let _ = child.kill();
}

fn spawn_shell_command(
    command: &str,
    cwd: &Path,
    env: HashMap<String, String>,
) -> Result<Child, std::io::Error> {
    let (program, args) = shell_command(command);
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.spawn()
}

#[cfg(unix)]
fn shell_command(command: &str) -> (&str, [&str; 2]) {
    ("sh", ["-c", command])
}

#[cfg(not(unix))]
fn shell_command(command: &str) -> (&str, [&str; 2]) {
    ("cmd", ["/C", command])
}

pub fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return "/".to_string();
    }
    format!("/{}", trimmed.trim_start_matches('/'))
}

fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn combine_url(base_url: &str, path: &str) -> String {
    format!("{}{}", normalize_base_url(base_url), normalize_path(path))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
