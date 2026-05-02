use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, Transaction};
#[cfg(test)]
use rusqlite::Connection;
use ulid::Ulid;

use super::types::{AppendError, AppendOutcome, AppendedEvent, EventMetadata, NewEvent};

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn current_max_seq(
    tx: &Transaction,
    aggregate_type: &str,
    aggregate_id: &str,
) -> Result<i64, AppendError> {
    let seq: Option<i64> = tx
        .query_row(
            "SELECT MAX(seq) FROM events WHERE aggregate_type = ?1 AND aggregate_id = ?2",
            params![aggregate_type, aggregate_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(seq.unwrap_or(0))
}

fn find_existing_by_command_id(
    tx: &Transaction,
    aggregate_type: &str,
    aggregate_id: &str,
    command_id: &str,
) -> Result<Vec<AppendedEvent>, AppendError> {
    let mut stmt = tx.prepare(
        "SELECT id, aggregate_type, aggregate_id, seq, event_type, version, payload, metadata, created_at
         FROM events
         WHERE aggregate_type = ?1 AND aggregate_id = ?2
           AND json_extract(metadata, '$.command_id') = ?3
         ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map(params![aggregate_type, aggregate_id, command_id], |row| {
        Ok(AppendedEvent {
            id: row.get(0)?,
            aggregate_type: row.get(1)?,
            aggregate_id: row.get(2)?,
            seq: row.get(3)?,
            event_type: row.get(4)?,
            version: row.get(5)?,
            payload: row.get(6)?,
            metadata: row.get(7)?,
            created_at: row.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Append events to a single aggregate's stream, inside a caller-managed transaction.
///
/// `expected_seq` is the current last seq for the aggregate (0 means "no prior events").
/// If an event with the same `command_id` already exists for this aggregate, the call is
/// treated as an idempotent replay: existing events returned, no new events appended.
pub fn append_events_in_tx(
    tx: &Transaction,
    aggregate_type: &str,
    aggregate_id: &str,
    expected_seq: i64,
    events: Vec<NewEvent>,
    metadata: &EventMetadata,
) -> Result<AppendOutcome, AppendError> {
    if events.is_empty() {
        return Err(AppendError::InvalidInput("events must not be empty".into()));
    }

    let metadata_json = serde_json::to_string(metadata)?;
    let created_at = now_millis();

    let existing =
        find_existing_by_command_id(tx, aggregate_type, aggregate_id, &metadata.command_id)?;
    if !existing.is_empty() {
        return Ok(AppendOutcome {
            events: existing,
            idempotent_replay: true,
        });
    }

    let actual = current_max_seq(tx, aggregate_type, aggregate_id)?;
    if actual != expected_seq {
        return Err(AppendError::ConcurrencyConflict {
            expected: expected_seq,
            actual,
        });
    }

    let mut appended = Vec::with_capacity(events.len());
    for (i, ev) in events.into_iter().enumerate() {
        let seq = expected_seq + 1 + i as i64;
        let id = Ulid::new().to_string();

        tx.execute(
            "INSERT INTO events (id, aggregate_type, aggregate_id, seq, event_type, version, payload, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                aggregate_type,
                aggregate_id,
                seq,
                ev.event_type,
                ev.version,
                ev.payload,
                metadata_json,
                created_at,
            ],
        )?;

        appended.push(AppendedEvent {
            id,
            aggregate_type: aggregate_type.to_string(),
            aggregate_id: aggregate_id.to_string(),
            seq,
            event_type: ev.event_type,
            version: ev.version,
            payload: ev.payload,
            metadata: metadata_json.clone(),
            created_at,
        });
    }

    Ok(AppendOutcome {
        events: appended,
        idempotent_replay: false,
    })
}

/// Convenience wrapper: opens a transaction, appends, commits.
/// Use `append_events_in_tx` directly when you need to combine the append with projection
/// updates in the same transaction.
#[cfg(test)]
pub fn append_events(
    conn: &mut Connection,
    aggregate_type: &str,
    aggregate_id: &str,
    expected_seq: i64,
    events: Vec<NewEvent>,
    metadata: EventMetadata,
) -> Result<AppendOutcome, AppendError> {
    let tx = conn.transaction()?;
    let outcome =
        append_events_in_tx(&tx, aggregate_type, aggregate_id, expected_seq, events, &metadata)?;
    tx.commit()?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::schema::apply_events_ddl;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        apply_events_ddl(&conn).unwrap();
        conn
    }

    fn meta(cmd: &str) -> EventMetadata {
        EventMetadata {
            command_id: cmd.to_string(),
            actor: "user:test".into(),
            correlation_id: None,
            causation_id: None,
        }
    }

    fn ev(t: &str, payload: &str) -> NewEvent {
        NewEvent {
            event_type: t.to_string(),
            version: 1,
            payload: payload.to_string(),
        }
    }

    #[test]
    fn happy_path_single_event() {
        let mut conn = open_test_db();
        let outcome = append_events(
            &mut conn,
            "task",
            "task_1",
            0,
            vec![ev("TaskCreated", "{}")],
            meta("cmd_1"),
        )
        .unwrap();
        assert!(!outcome.idempotent_replay);
        assert_eq!(outcome.events.len(), 1);
        assert_eq!(outcome.events[0].seq, 1);
    }

    #[test]
    fn multi_event_atomic_append() {
        let mut conn = open_test_db();
        let outcome = append_events(
            &mut conn,
            "phase_run",
            "pr_1",
            0,
            vec![
                ev("PhaseRunStarted", "{}"),
                ev("PhaseRunOutputAppended", "{}"),
                ev("PhaseRunCompleted", "{}"),
            ],
            meta("cmd_a"),
        )
        .unwrap();
        assert_eq!(outcome.events.len(), 3);
        assert_eq!(outcome.events[0].seq, 1);
        assert_eq!(outcome.events[1].seq, 2);
        assert_eq!(outcome.events[2].seq, 3);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn concurrency_conflict() {
        let mut conn = open_test_db();
        append_events(
            &mut conn,
            "task",
            "task_x",
            0,
            vec![ev("TaskCreated", "{}")],
            meta("cmd_1"),
        )
        .unwrap();

        let err = append_events(
            &mut conn,
            "task",
            "task_x",
            0,
            vec![ev("TaskSpecRevised", "{}")],
            meta("cmd_2"),
        )
        .unwrap_err();

        match err {
            AppendError::ConcurrencyConflict { expected, actual } => {
                assert_eq!(expected, 0);
                assert_eq!(actual, 1);
            }
            _ => panic!("wrong error: {:?}", err),
        }
    }

    #[test]
    fn idempotent_retry_returns_existing() {
        let mut conn = open_test_db();
        let first = append_events(
            &mut conn,
            "task",
            "task_y",
            0,
            vec![ev("TaskCreated", "{}")],
            meta("cmd_dup"),
        )
        .unwrap();
        assert!(!first.idempotent_replay);

        let retry = append_events(
            &mut conn,
            "task",
            "task_y",
            0,
            vec![ev("TaskCreated", "{}")],
            meta("cmd_dup"),
        )
        .unwrap();
        assert!(retry.idempotent_replay);
        assert_eq!(retry.events.len(), 1);
        assert_eq!(retry.events[0].id, first.events[0].id);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn rejects_empty_events() {
        let mut conn = open_test_db();
        let err = append_events(&mut conn, "task", "t", 0, vec![], meta("c")).unwrap_err();
        assert!(matches!(err, AppendError::InvalidInput(_)));
    }
}
