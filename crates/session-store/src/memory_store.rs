use super::*;

impl LocalStore {
    pub fn create_memory(&self, input: NewMemoryEntry) -> Result<MemoryEntry> {
        let text = normalize_memory_text(&input.text)?;
        let normalized = normalized_memory_key(&text);
        let source_item_id = normalize_optional_text(input.source_item_id, 512)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        if let Some(task_id) = input.source_task_id {
            ensure_task_exists(&transaction, task_id)?;
        }
        ensure_memory_capacity(&transaction, None)?;
        let now = Utc::now();
        let memory = MemoryEntry {
            id: MemoryId::new(),
            text,
            state: MemoryState::Active,
            creator: input.creator,
            source_task_id: input.source_task_id,
            source_item_id,
            created_at: now,
            updated_at: now,
            last_used_at: None,
        };
        transaction
            .execute(
                "INSERT INTO memories(id, text, normalized_text, state, creator, source_task_id, source_item_id, created_at, updated_at, last_used_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
                params![
                    memory.id.to_string(),
                    &memory.text,
                    normalized,
                    memory.state.as_str(),
                    memory.creator.as_str(),
                    memory.source_task_id.map(|id| id.to_string()),
                    &memory.source_item_id,
                    memory.created_at.to_rfc3339(),
                    memory.updated_at.to_rfc3339(),
                ],
            )
            .map_err(|error| map_memory_write_error(error, "memory already exists"))?;
        transaction.commit().map_err(storage_error)?;
        Ok(memory)
    }

    pub fn list_memories(&self) -> Result<Vec<MemoryEntry>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, text, state, creator, source_task_id, source_item_id, created_at, updated_at, last_used_at \
                 FROM memories ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_memory_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_memory(row.map_err(storage_error)?))
            .collect()
    }

    pub fn update_memory_text(&self, memory_id: MemoryId, text: &str) -> Result<MemoryEntry> {
        let text = normalize_memory_text(text)?;
        let normalized = normalized_memory_key(&text);
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE memories SET text = ?1, normalized_text = ?2, updated_at = ?3 WHERE id = ?4",
                params![text, normalized, Utc::now().to_rfc3339(), memory_id.to_string()],
            )
            .map_err(|error| map_memory_write_error(error, "memory already exists"))?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("memory {memory_id}")));
        }
        self.get_memory(memory_id)
    }

    pub fn set_memory_state(&self, memory_id: MemoryId, state: MemoryState) -> Result<MemoryEntry> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        if state == MemoryState::Active {
            ensure_memory_capacity(&transaction, Some(memory_id))?;
        }
        let changed = transaction
            .execute(
                "UPDATE memories SET state = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    state.as_str(),
                    Utc::now().to_rfc3339(),
                    memory_id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("memory {memory_id}")));
        }
        let memory = query_memory(&transaction, memory_id)?;
        transaction.commit().map_err(storage_error)?;
        Ok(memory)
    }

    pub fn delete_memory(&self, memory_id: MemoryId) -> Result<()> {
        let changed = self
            .connection
            .lock()
            .execute(
                "DELETE FROM memories WHERE id = ?1",
                [memory_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("memory {memory_id}")));
        }
        Ok(())
    }

    pub fn active_memories_for_injection(&self) -> Result<Vec<MemoryEntry>> {
        const TOTAL_CHAR_LIMIT: usize = 8_000;
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, text, state, creator, source_task_id, source_item_id, created_at, updated_at, last_used_at \
                 FROM memories WHERE state = 'active' ORDER BY updated_at DESC, id LIMIT 20",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_memory_row)
            .map_err(storage_error)?;
        let mut included = Vec::new();
        let mut used = 0;
        for row in rows {
            let memory = parse_memory(row.map_err(storage_error)?)?;
            let chars = memory.text.chars().count();
            if used + chars > TOTAL_CHAR_LIMIT {
                break;
            }
            used += chars;
            included.push(memory);
        }
        Ok(included)
    }

    pub fn mark_memories_used(&self, memory_ids: &[MemoryId]) -> Result<()> {
        if memory_ids.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let now = Utc::now().to_rfc3339();
        for memory_id in memory_ids {
            transaction
                .execute(
                    "UPDATE memories SET last_used_at = ?1 WHERE id = ?2 AND state = 'active'",
                    params![&now, memory_id.to_string()],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)
    }

    fn get_memory(&self, memory_id: MemoryId) -> Result<MemoryEntry> {
        query_memory(&self.connection.lock(), memory_id)
    }
}

type MemoryRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
);

fn parse_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}

fn parse_memory(row: MemoryRow) -> Result<MemoryEntry> {
    let (
        id,
        text,
        state,
        creator,
        source_task_id,
        source_item_id,
        created_at,
        updated_at,
        last_used_at,
    ) = row;
    Ok(MemoryEntry {
        id: MemoryId::from_str(&id).map_err(invalid_stored)?,
        text,
        state: MemoryState::from_str(&state)?,
        creator: MemoryCreator::from_str(&creator)?,
        source_task_id: source_task_id
            .as_deref()
            .map(TaskId::from_str)
            .transpose()
            .map_err(invalid_stored)?,
        source_item_id,
        created_at: parse_time(&created_at)?,
        updated_at: parse_time(&updated_at)?,
        last_used_at: last_used_at.map(|value| parse_time(&value)).transpose()?,
    })
}

fn query_memory(connection: &Connection, memory_id: MemoryId) -> Result<MemoryEntry> {
    let row = connection
        .query_row(
            "SELECT id, text, state, creator, source_task_id, source_item_id, created_at, updated_at, last_used_at FROM memories WHERE id = ?1",
            [memory_id.to_string()],
            parse_memory_row,
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| IntegratorError::NotFound(format!("memory {memory_id}")))?;
    parse_memory(row)
}

fn normalize_memory_text(value: &str) -> Result<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > 500 || text.contains('\0') {
        return Err(IntegratorError::InvalidInput(
            "memory must contain 1 to 500 characters".into(),
        ));
    }
    if looks_like_memory_secret(text) {
        return Err(IntegratorError::InvalidInput(
            "memory looks like a credential or secret and was not saved".into(),
        ));
    }
    Ok(text.to_owned())
}

fn normalized_memory_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn looks_like_memory_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let labeled_secret = [
        "api_key",
        "api key:",
        "apikey=",
        "password:",
        "password=",
        "secret:",
        "secret=",
        "access_token",
        "refresh_token",
        "authorization: bearer",
        "-----begin private key-----",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let openai_style_key = lower.split_whitespace().any(|word| {
        let token = word.trim_matches(|character: char| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        });
        token
            .strip_prefix("sk-")
            .is_some_and(|suffix| suffix.len() >= 16)
    });
    labeled_secret || openai_style_key
}

fn ensure_memory_capacity(connection: &Connection, excluding: Option<MemoryId>) -> Result<()> {
    let count = match excluding {
        Some(memory_id) => connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE state = 'active' AND id <> ?1",
                [memory_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?,
        None => connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE state = 'active'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?,
    };
    if count >= 20 {
        return Err(IntegratorError::InvalidInput(
            "memory is full; disable or delete an entry before saving another".into(),
        ));
    }
    Ok(())
}

fn map_memory_write_error(error: rusqlite::Error, duplicate_message: &str) -> IntegratorError {
    if matches!(
        error,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::ConstraintViolation,
                ..
            },
            _
        )
    ) {
        IntegratorError::InvalidInput(duplicate_message.into())
    } else {
        storage_error(error)
    }
}
