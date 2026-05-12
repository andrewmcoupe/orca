use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use ulid::Ulid;

use crate::events::projections;
use crate::ActiveWorkspace;

pub const TERMINAL_OUTPUT_EVENT: &str = "terminal_output";
pub const TERMINAL_EXIT_EVENT: &str = "terminal_exit";
pub const TERMINAL_LABEL_EVENT: &str = "terminal_label";
const MAX_SCROLLBACK_CHUNKS: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSessionInfo {
    pub terminal_id: String,
    pub workspace_id: String,
    pub task_id: String,
    pub cwd: String,
    pub shell: String,
    pub label: String,
    pub exited: bool,
}

#[derive(Debug, Serialize)]
pub struct TerminalAttachInfo {
    #[serde(flatten)]
    pub session: TerminalSessionInfo,
    pub scrollback: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutputEvent {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalExitEvent {
    pub terminal_id: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalLabelEvent {
    pub terminal_id: String,
    pub label: String,
}

pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create(
        &self,
        app: AppHandle,
        aw: &ActiveWorkspace,
        task_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionInfo, String> {
        let task = projections::get_task(&aw.conn, task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "task not found".to_string())?;

        if task.worktree_status.as_deref() != Some("active") {
            return Err("task worktree is not active".into());
        }

        let cwd = task
            .worktree_path
            .as_deref()
            .ok_or_else(|| "task has no worktree".to_string())
            .map(PathBuf::from)?;

        validate_worktree_path(Path::new(&aw.path), &cwd, task_id)?;

        let shell = default_shell();
        let initial_label = process_label(&shell);
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);
        configure_prompt(&mut cmd);

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.max(8),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open terminal pty: {e}"))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell `{shell}`: {e}"))?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to attach terminal reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to attach terminal writer: {e}"))?;

        let terminal_id = Ulid::new().to_string();
        let session = Arc::new(TerminalSession {
            terminal_id: terminal_id.clone(),
            workspace_id: aw.id.clone(),
            task_id: task_id.to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            shell: shell.clone(),
            master: Mutex::new(pair.master),
            killer: Mutex::new(Some(killer)),
            writer: Mutex::new(writer),
            label: Mutex::new(initial_label.clone()),
            fallback_label: initial_label.clone(),
            scrollback: Mutex::new(BoundedScrollback::new(MAX_SCROLLBACK_CHUNKS)),
            closed: AtomicBool::new(false),
        });

        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(terminal_id.clone(), Arc::clone(&session));
        }

        self.spawn_reader(
            app.clone(),
            terminal_id.clone(),
            Arc::clone(&session),
            reader,
        );
        self.spawn_labeler(app.clone(), terminal_id.clone(), Arc::clone(&session));
        self.spawn_waiter(app, terminal_id.clone(), Arc::clone(&session), child);

        Ok(TerminalSessionInfo {
            terminal_id,
            workspace_id: aw.id.clone(),
            task_id: task_id.to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            shell,
            label: initial_label,
            exited: false,
        })
    }

    pub fn list_for_task(
        &self,
        workspace_id: &str,
        task_id: &str,
    ) -> Result<Vec<TerminalSessionInfo>, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let mut list = sessions
            .values()
            .filter(|session| session.workspace_id == workspace_id && session.task_id == task_id)
            .map(|session| session.info())
            .collect::<Vec<_>>();
        list.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
        Ok(list)
    }

    pub fn attach(&self, terminal_id: &str) -> Result<TerminalAttachInfo, String> {
        let session = self.session(terminal_id)?;
        Ok(TerminalAttachInfo {
            session: session.info(),
            scrollback: session.scrollback(),
        })
    }

    pub fn write(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        let session = self.session(terminal_id)?;
        if session.closed.load(Ordering::SeqCst) {
            return Err("terminal is closed".into());
        }
        let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("failed to write to terminal: {e}"))?;
        writer
            .flush()
            .map_err(|e| format!("failed to flush terminal input: {e}"))
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(terminal_id)?;
        let master = session.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows: rows.max(8),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to resize terminal: {e}"))
    }

    pub fn close(&self, terminal_id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.remove(terminal_id)
        };
        if let Some(session) = session {
            session.close();
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut guard) => guard.drain().map(|(_, s)| s).collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in sessions {
            session.close();
        }
    }

    fn session(&self, terminal_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| "terminal session not found".to_string())
    }

    fn spawn_reader(
        &self,
        app: AppHandle,
        terminal_id: String,
        session: Arc<TerminalSession>,
        mut reader: Box<dyn Read + Send>,
    ) {
        thread::spawn(move || {
            let mut buf = [0_u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        session.push_scrollback(data.clone());
                        let _ = app.emit(
                            TERMINAL_OUTPUT_EVENT,
                            TerminalOutputEvent {
                                terminal_id: terminal_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }

    fn spawn_waiter(
        &self,
        app: AppHandle,
        terminal_id: String,
        session: Arc<TerminalSession>,
        mut child: Box<dyn Child + Send + Sync>,
    ) {
        let manager = self.clone_handle();
        thread::spawn(move || {
            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);

            session.closed.store(true, Ordering::SeqCst);
            if let Ok(mut killer) = session.killer.lock() {
                killer.take();
            }
            session.push_scrollback(format!(
                "\r\n\x1b[90mterminal exited{}\x1b[0m\r\n",
                exit_code
                    .map(|code| format!(" with code {code}"))
                    .unwrap_or_default()
            ));
            manager.mark_exited(&terminal_id);
            let _ = app.emit(
                TERMINAL_EXIT_EVENT,
                TerminalExitEvent {
                    terminal_id,
                    exit_code,
                },
            );
        });
    }

    fn spawn_labeler(&self, app: AppHandle, terminal_id: String, session: Arc<TerminalSession>) {
        thread::spawn(move || {
            let mut last = session.current_label();
            let _ = app.emit(
                TERMINAL_LABEL_EVENT,
                TerminalLabelEvent {
                    terminal_id: terminal_id.clone(),
                    label: last.clone(),
                },
            );

            while !session.closed.load(Ordering::SeqCst) {
                let next = session.detect_foreground_label();
                if next != last {
                    session.set_label(&next);
                    last = next;
                    let _ = app.emit(
                        TERMINAL_LABEL_EVENT,
                        TerminalLabelEvent {
                            terminal_id: terminal_id.clone(),
                            label: last.clone(),
                        },
                    );
                }
                thread::sleep(Duration::from_millis(700));
            }
        });
    }

    fn clone_handle(&self) -> TerminalManagerHandle {
        TerminalManagerHandle {
            sessions: Arc::clone(&self.sessions),
        }
    }
}

struct TerminalManagerHandle {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalManagerHandle {
    fn mark_exited(&self, terminal_id: &str) {
        if let Ok(sessions) = self.sessions.lock() {
            if let Some(session) = sessions.get(terminal_id) {
                session.closed.store(true, Ordering::SeqCst);
            }
        }
    }
}

pub struct TerminalSession {
    terminal_id: String,
    workspace_id: String,
    task_id: String,
    cwd: String,
    shell: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    label: Mutex<String>,
    fallback_label: String,
    scrollback: Mutex<BoundedScrollback>,
    closed: AtomicBool,
}

impl TerminalSession {
    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut killer_guard) = self.killer.lock() {
            if let Some(mut killer) = killer_guard.take() {
                let _ = killer.kill();
            }
        }
    }

    fn current_label(&self) -> String {
        self.label
            .lock()
            .map(|label| label.clone())
            .unwrap_or_else(|_| self.fallback_label.clone())
    }

    fn set_label(&self, next: &str) {
        if let Ok(mut label) = self.label.lock() {
            *label = next.to_string();
        }
    }

    fn detect_foreground_label(&self) -> String {
        foreground_process_label(&self.master).unwrap_or_else(|| self.fallback_label.clone())
    }

    fn info(&self) -> TerminalSessionInfo {
        TerminalSessionInfo {
            terminal_id: self.terminal_id.clone(),
            workspace_id: self.workspace_id.clone(),
            task_id: self.task_id.clone(),
            cwd: self.cwd.clone(),
            shell: self.shell.clone(),
            label: self.current_label(),
            exited: self.closed.load(Ordering::SeqCst),
        }
    }

    fn push_scrollback(&self, data: String) {
        if let Ok(mut scrollback) = self.scrollback.lock() {
            scrollback.push(data);
        }
    }

    fn scrollback(&self) -> Vec<String> {
        self.scrollback
            .lock()
            .map(|scrollback| scrollback.snapshot())
            .unwrap_or_default()
    }
}

struct BoundedScrollback {
    max_chunks: usize,
    chunks: VecDeque<String>,
}

impl BoundedScrollback {
    fn new(max_chunks: usize) -> Self {
        Self {
            max_chunks,
            chunks: VecDeque::new(),
        }
    }

    fn push(&mut self, data: String) {
        if self.max_chunks == 0 {
            return;
        }
        while self.chunks.len() >= self.max_chunks {
            self.chunks.pop_front();
        }
        self.chunks.push_back(data);
    }

    fn snapshot(&self) -> Vec<String> {
        self.chunks.iter().cloned().collect()
    }
}

#[cfg(target_os = "windows")]
fn default_shell() -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
}

#[cfg(not(target_os = "windows"))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

#[cfg(unix)]
fn configure_prompt(cmd: &mut CommandBuilder) {
    cmd.env("PS1", "$ ");
    cmd.env("PROMPT", "$ ");
    cmd.env("RPROMPT", "");
}

#[cfg(not(unix))]
fn configure_prompt(_cmd: &mut CommandBuilder) {}

fn validate_worktree_path(workspace_path: &Path, cwd: &Path, task_id: &str) -> Result<(), String> {
    let expected = crate::worktree::worktree_path_for(workspace_path, task_id);
    let expected = expected
        .canonicalize()
        .map_err(|e| format!("expected worktree path is unavailable: {e}"))?;
    let actual = cwd
        .canonicalize()
        .map_err(|e| format!("worktree path is unavailable: {e}"))?;
    if actual == expected {
        Ok(())
    } else {
        Err("task worktree path failed validation".into())
    }
}

fn process_label(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(command)
        .to_string()
}

#[cfg(unix)]
fn foreground_process_label(master: &Mutex<Box<dyn MasterPty + Send>>) -> Option<String> {
    let pgid = master.lock().ok()?.process_group_leader()?;
    process_name_for_group(pgid)
}

#[cfg(not(unix))]
fn foreground_process_label(_master: &Mutex<Box<dyn MasterPty + Send>>) -> Option<String> {
    None
}

#[cfg(unix)]
fn process_name_for_group(pgid: libc::pid_t) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pgid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(process_label(&text))
    }
}

#[cfg(test)]
mod tests {
    use super::BoundedScrollback;

    #[test]
    fn bounded_scrollback_keeps_recent_chunks() {
        let mut scrollback = BoundedScrollback::new(3);
        scrollback.push("one".into());
        scrollback.push("two".into());
        scrollback.push("three".into());
        scrollback.push("four".into());

        assert_eq!(scrollback.snapshot(), vec!["two", "three", "four"]);
    }

    #[test]
    fn bounded_scrollback_can_be_disabled() {
        let mut scrollback = BoundedScrollback::new(0);
        scrollback.push("ignored".into());

        assert!(scrollback.snapshot().is_empty());
    }
}
