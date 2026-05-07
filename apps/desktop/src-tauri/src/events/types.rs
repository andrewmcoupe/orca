use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewEvent {
    pub event_type: String,
    pub version: i64,
    /// Already-serialized JSON payload.
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventMetadata {
    pub command_id: String,
    pub actor: String,
    pub correlation_id: Option<String>,
    pub causation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppendedEvent {
    pub id: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub seq: i64,
    pub event_type: String,
    pub version: i64,
    pub payload: String,
    pub metadata: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppendOutcome {
    pub events: Vec<AppendedEvent>,
    /// True when the call was an idempotent no-op — events already existed for this command_id.
    pub idempotent_replay: bool,
}

#[derive(Debug, Error)]
pub enum AppendError {
    #[error("concurrency conflict: expected next seq {expected}, found {actual}")]
    ConcurrencyConflict { expected: i64, actual: i64 },

    #[error("serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("database error: {0}")]
    DatabaseError(#[from] rusqlite::Error),

    #[error("invalid input: {0}")]
    InvalidInput(String),
}
