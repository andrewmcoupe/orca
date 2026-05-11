//! Per-workspace write serialization.
//!
//! SQLite is fundamentally single-writer. When multiple connections to the same
//! workspace `events.sqlite` race to begin a write transaction, the loser polls
//! and eventually fails with `SQLITE_BUSY` once `busy_timeout` expires. Symptoms
//! we've actually hit: a queued task auto-starting right after a `TaskMerged`
//! commit fires the unblock hook, both connections try to write, and the second
//! one errors out with "database is locked" (manifesting as
//! `worktree_creation_failed`).
//!
//! This module funnels every write transaction through a per-workspace mutex so
//! callers queue at the Rust layer and SQLite never sees contending writers.
//! Reads are unaffected — WAL still lets readers proceed concurrently.
//!
//! Usage from a call site that manages its own transaction:
//!
//! ```ignore
//! let _w = workspace_writer(workspace_id);
//! let _g = _w.lock().expect("workspace writer poisoned");
//! let tx = conn.transaction()?;
//! append_events_in_tx(&tx, ...)?;
//! tx.commit()?;
//! ```
//!
//! Helpers like `append_task_step` / `append_phase_run_step` already acquire
//! the lock internally, so callers that go through them don't need to.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Default)]
struct Registry {
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Registry {
    fn lock_for(&self, workspace_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.locks.lock().expect("write_lock registry poisoned");
        if let Some(existing) = map.get(workspace_id) {
            return existing.clone();
        }
        let new = Arc::new(Mutex::new(()));
        map.insert(workspace_id.to_string(), new.clone());
        new
    }
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

/// Returns the write mutex for `workspace_id`. Hold the resulting `MutexGuard`
/// (via `.lock()`) for the duration of the write transaction. The returned
/// `Arc` keeps the mutex alive across guard drop so subsequent callers see the
/// same instance.
pub fn workspace_writer(workspace_id: &str) -> Arc<Mutex<()>> {
    registry().lock_for(workspace_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn returns_same_lock_for_same_workspace() {
        let a = workspace_writer("ws1");
        let b = workspace_writer("ws1");
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn distinct_locks_per_workspace() {
        let a = workspace_writer("ws_distinct_a");
        let b = workspace_writer("ws_distinct_b");
        assert!(!Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn serializes_concurrent_writers() {
        let lock = workspace_writer("ws_serialize");
        let g = lock.lock().unwrap();

        let lock2 = workspace_writer("ws_serialize");
        let handle = thread::spawn(move || {
            let _g2 = lock2.lock().unwrap();
            "got it"
        });

        thread::sleep(Duration::from_millis(50));
        assert!(!handle.is_finished());
        drop(g);
        assert_eq!(handle.join().unwrap(), "got it");
    }
}
