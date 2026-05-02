//! Phase runners. A "phase" is a single execution against a task — fake or real.
//!
//! Each runner is responsible for emitting `PhaseRunStarted` / `PhaseRunOutputAppended` /
//! `PhaseRunCompleted` (or `PhaseRunFailed`) through `append_events`, with projection
//! updates and `projection_updated` Tauri events fired in the usual way.

pub mod fake;
pub mod implementer;
pub mod runtime;
pub mod test_author;

pub use runtime::InflightRuns;
