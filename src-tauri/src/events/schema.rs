pub const EVENTS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    event_type      TEXT NOT NULL,
    version         INTEGER NOT NULL,
    payload         TEXT NOT NULL,
    metadata        TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    UNIQUE (aggregate_type, aggregate_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_aggregate
    ON events (aggregate_type, aggregate_id, seq);

CREATE INDEX IF NOT EXISTS idx_events_created_at
    ON events (created_at);
"#;

pub fn apply_events_ddl(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(EVENTS_DDL)
}
