use super::*;

impl LocalStore {
    pub fn enqueue_message(&self, input: NewQueuedMessage) -> Result<QueuedMessage> {
        const QUEUE_LIMIT: i64 = 100;
        let input = normalize_queued_message(input)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        ensure_task_exists(&transaction, input.task_id)?;
        let count = transaction
            .query_row(
                "SELECT COUNT(*) FROM queued_messages WHERE task_id = ?1",
                [input.task_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        if count >= QUEUE_LIMIT {
            return Err(IntegratorError::Unavailable(
                "a task cannot queue more than 100 messages".into(),
            ));
        }
        let position = transaction
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM queued_messages WHERE task_id = ?1",
                [input.task_id.to_string()],
                |row| row.get::<_, u32>(0),
            )
            .map_err(storage_error)?;
        let now = Utc::now();
        let message = QueuedMessage {
            id: QueuedMessageId::new(),
            task_id: input.task_id,
            prompt: input.prompt,
            attachments: input.attachments,
            context_references: input.context_references,
            runtime: input.runtime,
            model: input.model,
            effort: input.effort,
            permission: input.permission,
            delegation: input.delegation,
            native_action_id: input.native_action_id,
            position,
            state: QueuedMessageState::Queued,
            created_at: now,
            updated_at: now,
        };
        insert_queued_message(&transaction, &message)?;
        transaction.commit().map_err(storage_error)?;
        Ok(message)
    }

    pub fn list_queued_messages(&self, task_id: TaskId) -> Result<Vec<QueuedMessage>> {
        let connection = self.connection.lock();
        ensure_task_exists(&connection, task_id)?;
        let mut statement = connection
            .prepare(
                "SELECT id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 ORDER BY position, created_at",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([task_id.to_string()], parse_queued_message_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_queued_message(row.map_err(storage_error)?))
            .collect()
    }

    pub fn reorder_queued_messages(
        &self,
        task_id: TaskId,
        ordered_ids: &[QueuedMessageId],
    ) -> Result<Vec<QueuedMessage>> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        ensure_task_exists(&transaction, task_id)?;
        let mut statement = transaction
            .prepare("SELECT id FROM queued_messages WHERE task_id = ?1 ORDER BY position")
            .map_err(storage_error)?;
        let stored_ids = statement
            .query_map([task_id.to_string()], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        drop(statement);
        let requested_ids = ordered_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let mut stored_set = stored_ids.clone();
        let mut requested_set = requested_ids.clone();
        stored_set.sort_unstable();
        requested_set.sort_unstable();
        requested_set.dedup();
        if stored_set != requested_set || requested_ids.len() != requested_set.len() {
            return Err(IntegratorError::InvalidInput(
                "queued message reorder must contain every task message exactly once".into(),
            ));
        }
        let offset = i64::try_from(stored_ids.len()).unwrap_or(100) + 1;
        transaction
            .execute(
                "UPDATE queued_messages SET position = position + ?1 WHERE task_id = ?2",
                params![offset, task_id.to_string()],
            )
            .map_err(storage_error)?;
        let now = Utc::now().to_rfc3339();
        for (position, id) in ordered_ids.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE queued_messages SET position = ?1, updated_at = ?2 WHERE id = ?3 AND task_id = ?4",
                    params![position as i64, now, id.to_string(), task_id.to_string()],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        drop(connection);
        self.list_queued_messages(task_id)
    }

    pub fn take_queued_message(
        &self,
        task_id: TaskId,
        message_id: QueuedMessageId,
    ) -> Result<QueuedMessage> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let row = transaction
            .query_row(
                "SELECT id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 AND id = ?2",
                params![task_id.to_string(), message_id.to_string()],
                parse_queued_message_row,
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("queued message {message_id}")))?;
        let message = parse_queued_message(row)?;
        transaction
            .execute(
                "DELETE FROM queued_messages WHERE task_id = ?1 AND id = ?2",
                params![task_id.to_string(), message_id.to_string()],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(message)
    }

    pub fn set_queued_message_state(
        &self,
        task_id: TaskId,
        message_id: QueuedMessageId,
        state: QueuedMessageState,
    ) -> Result<QueuedMessage> {
        let connection = self.connection.lock();
        let changed = connection
            .execute(
                "UPDATE queued_messages SET state = ?1, updated_at = ?2 WHERE task_id = ?3 AND id = ?4",
                params![
                    state.as_str(),
                    Utc::now().to_rfc3339(),
                    task_id.to_string(),
                    message_id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(IntegratorError::NotFound(format!(
                "queued message {message_id}"
            )));
        }
        let row = connection
            .query_row(
                "SELECT id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages WHERE task_id = ?1 AND id = ?2",
                params![task_id.to_string(), message_id.to_string()],
                parse_queued_message_row,
            )
            .map_err(storage_error)?;
        parse_queued_message(row)
    }

    pub fn recover_dispatching_queued_messages(&self) -> Result<usize> {
        self.connection
            .lock()
            .execute(
                "UPDATE queued_messages SET state = 'queued', updated_at = ?1 WHERE state = 'dispatching'",
                [Utc::now().to_rfc3339()],
            )
            .map_err(storage_error)
    }
}

fn normalize_queued_message(mut input: NewQueuedMessage) -> Result<NewQueuedMessage> {
    const PROMPT_LIMIT: usize = 2 * 1024 * 1024;
    const ATTACHMENT_LIMIT: usize = 64;
    if input.prompt.trim().is_empty() && input.attachments.is_empty() {
        return Err(IntegratorError::InvalidInput(
            "queued message must contain text or an attachment".into(),
        ));
    }
    if input.prompt.len() > PROMPT_LIMIT {
        return Err(IntegratorError::InvalidInput(
            "queued message must not exceed 2 MiB".into(),
        ));
    }
    if input.attachments.len() > ATTACHMENT_LIMIT {
        return Err(IntegratorError::InvalidInput(format!(
            "queued message must not contain more than {ATTACHMENT_LIMIT} attachments"
        )));
    }
    validate_context_references(&input.context_references)?;
    for attachment in &input.attachments {
        if attachment.path.is_empty()
            || attachment.path.chars().count() > 32_768
            || attachment.path.contains('\0')
            || attachment.name.is_empty()
            || attachment.name.chars().count() > 512
            || !matches!(attachment.kind.as_str(), "file" | "image")
            || attachment
                .entry
                .as_deref()
                .is_some_and(|entry| !matches!(entry, "file" | "folder"))
        {
            return Err(IntegratorError::InvalidInput(
                "queued message contains an invalid attachment reference".into(),
            ));
        }
    }
    input.runtime = normalize_required_text(input.runtime, 64, "queued runtime")?;
    input.model = normalize_required_text(input.model, 120, "queued model")?;
    input.effort = normalize_optional_text(input.effort, 64)?;
    input.native_action_id = normalize_optional_text(input.native_action_id, 512)?;
    if !matches!(
        input.permission.as_str(),
        "read-only" | "project-write" | "ask" | "auto" | "full-access"
    ) {
        return Err(IntegratorError::InvalidInput(
            "invalid queued permission profile".into(),
        ));
    }
    if !matches!(
        input.delegation.as_str(),
        "off" | "manual" | "balanced" | "budget-first"
    ) {
        return Err(IntegratorError::InvalidInput(
            "invalid queued delegation mode".into(),
        ));
    }
    Ok(input)
}

fn insert_queued_message(connection: &Connection, message: &QueuedMessage) -> Result<()> {
    let attachments = serde_json::to_string(&message.attachments)?;
    let context_references = serde_json::to_string(&message.context_references)?;
    connection
        .execute(
            "INSERT INTO queued_messages(id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                message.id.to_string(),
                message.task_id.to_string(),
                &message.prompt,
                attachments,
                context_references,
                &message.runtime,
                &message.model,
                &message.effort,
                &message.permission,
                &message.delegation,
                &message.native_action_id,
                i64::from(message.position),
                message.state.as_str(),
                message.created_at.to_rfc3339(),
                message.updated_at.to_rfc3339(),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

pub(super) type QueuedMessageRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    i64,
    String,
    String,
    String,
);

pub(super) fn parse_queued_message_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<QueuedMessageRow> {
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
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
    ))
}

pub(super) fn parse_queued_message(row: QueuedMessageRow) -> Result<QueuedMessage> {
    let (
        id,
        task_id,
        prompt,
        attachments,
        context_references,
        runtime,
        model,
        effort,
        permission,
        delegation,
        native_action_id,
        position,
        state,
        created_at,
        updated_at,
    ) = row;
    Ok(QueuedMessage {
        id: QueuedMessageId::from_str(&id).map_err(invalid_stored)?,
        task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
        prompt,
        attachments: serde_json::from_str(&attachments)?,
        context_references: serde_json::from_str(&context_references)?,
        runtime,
        model,
        effort,
        permission,
        delegation,
        native_action_id,
        position: u32::try_from(position)
            .map_err(|_| IntegratorError::Storage("invalid queued message position".into()))?,
        state: QueuedMessageState::from_str(&state)?,
        created_at: parse_time(&created_at)?,
        updated_at: parse_time(&updated_at)?,
    })
}
