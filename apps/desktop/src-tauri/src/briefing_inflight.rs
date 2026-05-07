//! In-memory registry of briefing generations currently running on the tokio
//! runtime. The state container is registered via `app.manage()` and shared
//! across:
//!
//! - the start command (inserts an entry, refuses if one already exists for the
//!   briefing id),
//! - the cancel command (looks up the entry, fires its `CancellationToken`),
//! - the spawned task itself (removes its entry on completion via the RAII
//!   `InflightGuard` so a panic still cleans up),
//! - the app-quit handler (cancels every entry as a courtesy before the
//!   subprocess tracker kills the children),
//! - the workspace-activation restart-recovery sweep (compares the projection's
//!   `is_generating` set against this map to find rows stranded by a previous
//!   process exit).
//!
//! The map is keyed by `briefing_id` because that's the identity the user and
//! UI work in. Workspace ID is recorded alongside so cancel-on-workspace-switch
//! and the sweep can scope correctly without re-reading the projection.
//!
//! ## Invariants
//!
//! - At most one entry per `briefing_id`. `register` returns `Err` if the slot
//!   is already taken; the command layer translates that into a user-friendly
//!   "generation already in progress" message and refuses to spawn a duplicate.
//! - Insertion is followed by a `tokio::spawn` whose final action (whether
//!   success, error, panic, or cancellation) is to drop the corresponding
//!   `InflightGuard`, which removes the entry. This keeps the map a faithful
//!   snapshot of what's actually running.
//! - The `CancellationToken` stored here is the one passed to
//!   `briefing::run_briefing_generation`. Cancelling it interrupts the
//!   subprocess via `subprocess::run_streaming`'s cancel-aware loop.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

/// Logical kind of generation. Drives the spinner label on the briefing page
/// and shows up in the `BriefingGenerationStarted` payload so replays can
/// reconstruct UI state. Stored as a string in events for forward compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationKind {
    /// First draft for a freshly-created briefing.
    Initial,
    /// Subsequent regeneration triggered by the user (after edits / pushbacks).
    Refine,
}

impl GenerationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GenerationKind::Initial => "initial",
            GenerationKind::Refine => "refine",
        }
    }
}

/// One running generation's metadata. Cloning is cheap (Arc internally for the
/// token); the cancel command takes a clone so it can drop the map lock before
/// signalling, which avoids a held-lock-across-await scenario.
///
/// The `workspace_id`, `kind`, and `started_at` fields are kept here for
/// future use by chrome indicators or telemetry — the projection is the
/// authoritative source for UI state, but having these on the in-memory
/// entry lets us answer questions like "what's running right now?" without
/// a database round-trip if we ever need to.
#[derive(Clone)]
pub struct Inflight {
    #[allow(dead_code)]
    pub workspace_id: String,
    #[allow(dead_code)]
    pub kind: GenerationKind,
    #[allow(dead_code)]
    pub started_at: i64,
    pub cancel: CancellationToken,
}

/// Tauri-managed state. The mutex is fine here — entries are inserted, looked
/// up, and removed; no work is performed under the lock.
pub struct InflightBriefings {
    inner: Mutex<HashMap<String, Inflight>>,
}

impl InflightBriefings {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Insert a fresh entry for `briefing_id`. Returns `Err` if one already
    /// exists — the start command surfaces this as "generation already in
    /// progress". The command must call this **before** spawning so the
    /// idempotency check is race-free against a near-simultaneous second
    /// start.
    pub fn register(&self, briefing_id: &str, entry: Inflight) -> Result<(), String> {
        let mut g = self
            .inner
            .lock()
            .map_err(|e| format!("inflight briefings lock poisoned: {e}"))?;
        if g.contains_key(briefing_id) {
            return Err("generation already in progress for this briefing".into());
        }
        g.insert(briefing_id.to_string(), entry);
        Ok(())
    }

    /// Remove the entry for `briefing_id`. The spawned task calls this via the
    /// `InflightGuard` drop. Idempotent: a missing key is fine (the cancel
    /// path may have already removed it, or a unit test may have simulated a
    /// crash).
    pub fn remove(&self, briefing_id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(briefing_id);
        }
    }

    /// Look up an entry by id. Returns a clone; the caller signals cancel
    /// outside the lock.
    pub fn get(&self, briefing_id: &str) -> Option<Inflight> {
        self.inner.lock().ok()?.get(briefing_id).cloned()
    }

    /// Snapshot of every running briefing id. Used by the workspace-activation
    /// sweep — the caller compares the projection's `is_generating` set
    /// against this snapshot to find stranded rows from a previous process
    /// life.
    pub fn snapshot_ids(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|g| g.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Signal cancel on every live entry. Called from the app-quit handler so
    /// spawned tasks have a chance to land their `BriefingGenerationCancelled`
    /// event before the process exits. Best-effort: lock poisoning is
    /// swallowed because we're shutting down anyway.
    pub fn cancel_all(&self) {
        if let Ok(g) = self.inner.lock() {
            for entry in g.values() {
                entry.cancel.cancel();
            }
        }
    }
}

impl Default for InflightBriefings {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII helper: drops the inflight map entry when the spawned task ends, no
/// matter how. The spawned task takes one of these *before* the awaited
/// generation, so panics, cancellations, and ordinary returns all clean up.
///
/// The tracker is held as `Arc` so the guard owns enough state to run on drop
/// without borrowing the outer state container.
pub struct InflightGuard {
    tracker: Arc<InflightBriefings>,
    briefing_id: String,
    armed: bool,
}

impl InflightGuard {
    pub fn new(tracker: Arc<InflightBriefings>, briefing_id: String) -> Self {
        Self {
            tracker,
            briefing_id,
            armed: true,
        }
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if self.armed {
            self.tracker.remove(&self.briefing_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> Inflight {
        Inflight {
            workspace_id: "ws".into(),
            kind: GenerationKind::Initial,
            started_at: 0,
            cancel: CancellationToken::new(),
        }
    }

    #[test]
    fn register_then_remove_round_trips() {
        let t = InflightBriefings::new();
        t.register("b1", entry()).unwrap();
        assert!(t.get("b1").is_some());
        t.remove("b1");
        assert!(t.get("b1").is_none());
    }

    #[test]
    fn double_register_is_rejected() {
        let t = InflightBriefings::new();
        t.register("b1", entry()).unwrap();
        let err = t.register("b1", entry()).unwrap_err();
        assert!(err.contains("already in progress"));
    }

    #[test]
    fn cancel_all_signals_every_entry() {
        let t = InflightBriefings::new();
        let e1 = entry();
        let e2 = entry();
        let c1 = e1.cancel.clone();
        let c2 = e2.cancel.clone();
        t.register("b1", e1).unwrap();
        t.register("b2", e2).unwrap();
        assert!(!c1.is_cancelled());
        assert!(!c2.is_cancelled());
        t.cancel_all();
        assert!(c1.is_cancelled());
        assert!(c2.is_cancelled());
    }

    #[test]
    fn guard_drop_removes_entry() {
        let t = Arc::new(InflightBriefings::new());
        t.register("b1", entry()).unwrap();
        {
            let _g = InflightGuard::new(Arc::clone(&t), "b1".into());
        }
        assert!(t.get("b1").is_none());
    }

    #[test]
    fn snapshot_ids_lists_all_keys() {
        let t = InflightBriefings::new();
        t.register("b1", entry()).unwrap();
        t.register("b2", entry()).unwrap();
        let mut ids = t.snapshot_ids();
        ids.sort();
        assert_eq!(ids, vec!["b1".to_string(), "b2".into()]);
    }
}
