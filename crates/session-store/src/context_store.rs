use super::*;

impl LocalStore {
    /// Resolve one renderer-selected Chat reference inside the native store
    /// and persist the exact bounded Markdown snapshot supplied to the target.
    pub fn resolve_chat_context_reference(
        &self,
        target_task_id: TaskId,
        reference: &ChatContextReference,
    ) -> Result<TaskContextReference> {
        const MAX_RENDERED_CHARS: usize = 64 * 1024;
        const MAX_MESSAGES: usize = 500;

        if target_task_id == reference.source_task_id {
            return Err(IntegratorError::InvalidInput(
                "a chat cannot reference itself".into(),
            ));
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        ensure_task_exists(&transaction, target_task_id)?;
        let (source_kind, source_title) = transaction
            .query_row(
                "SELECT kind, title FROM tasks WHERE id = ?1",
                [reference.source_task_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| {
                IntegratorError::NotFound(format!("task {}", reference.source_task_id))
            })?;
        if TaskKind::from_str(&source_kind)? != TaskKind::Chat {
            return Err(IntegratorError::InvalidInput(
                "only Chat tasks can be used as chat context".into(),
            ));
        }

        let mut statement = transaction
            .prepare(
                "SELECT kind, body, last_event_seq FROM integrator_items \
                 WHERE task_id = ?1 AND kind IN ('user_message', 'agent_message') \
                   AND status = 'completed' AND body IS NOT NULL AND trim(body) <> '' \
                 ORDER BY CASE WHEN first_event_seq = 0 THEN last_event_seq ELSE first_event_seq END, last_event_seq",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([reference.source_task_id.to_string()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(storage_error)?;
        let mut messages = Vec::new();
        for row in rows {
            if messages.len() == MAX_MESSAGES {
                return Err(IntegratorError::InvalidInput(
                    "chat context is too large; select a smaller chat or wait for range controls"
                        .into(),
                ));
            }
            messages.push(row.map_err(storage_error)?);
        }
        drop(statement);
        if messages.is_empty() {
            return Err(IntegratorError::InvalidInput(
                "chat context has no completed messages".into(),
            ));
        }

        let mut markdown = format!("# Chat: {}\n", source_title.trim());
        let mut watermark = 0_i64;
        for (kind, body, seq) in &messages {
            let speaker = if kind == "user_message" {
                "User"
            } else {
                "Assistant"
            };
            markdown.push_str("\n## ");
            markdown.push_str(speaker);
            markdown.push_str("\n\n");
            markdown.push_str(body.trim());
            markdown.push('\n');
            watermark = watermark.max(*seq);
            if markdown.chars().count() > MAX_RENDERED_CHARS {
                return Err(IntegratorError::InvalidInput(
                    "chat context is too large; select a smaller chat or wait for range controls"
                        .into(),
                ));
            }
        }
        let rendered_chars = markdown.chars().count();
        let digest = format!("{:x}", Sha256::digest(markdown.as_bytes()));
        let created_at = Utc::now();
        transaction
            .execute(
                "INSERT INTO task_context_references(id, target_task_id, source_task_id, source_title, source_watermark, message_count, rendered_chars, rendered_sha256, rendered_markdown, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(id) DO NOTHING",
                params![
                    reference.id.to_string(),
                    target_task_id.to_string(),
                    reference.source_task_id.to_string(),
                    source_title,
                    watermark,
                    messages.len() as i64,
                    rendered_chars as i64,
                    digest,
                    markdown,
                    created_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        let stored = query_context_reference(&transaction, reference.id)?;
        if stored.target_task_id != target_task_id
            || stored.source_task_id != Some(reference.source_task_id)
        {
            return Err(IntegratorError::InvalidInput(
                "context reference id is already bound to another task".into(),
            ));
        }
        transaction.commit().map_err(storage_error)?;
        Ok(stored)
    }

    pub fn list_context_references(
        &self,
        target_task_id: TaskId,
    ) -> Result<Vec<TaskContextReference>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, target_task_id, source_task_id, source_title, source_watermark, message_count, rendered_chars, rendered_sha256, rendered_markdown, created_at \
                 FROM task_context_references WHERE target_task_id = ?1 ORDER BY created_at, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([target_task_id.to_string()], parse_context_reference_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_context_reference(row.map_err(storage_error)?))
            .collect()
    }
}

pub(super) fn validate_context_references(references: &[ChatContextReference]) -> Result<()> {
    const REFERENCE_LIMIT: usize = 8;
    if references.len() > REFERENCE_LIMIT {
        return Err(IntegratorError::InvalidInput(format!(
            "a message cannot contain more than {REFERENCE_LIMIT} chat references"
        )));
    }
    let mut ids = references
        .iter()
        .map(|reference| reference.id)
        .collect::<Vec<_>>();
    ids.sort_unstable_by_key(ToString::to_string);
    ids.dedup();
    if ids.len() != references.len()
        || references.iter().any(|reference| {
            reference.source_title.trim().is_empty()
                || reference.source_title.chars().count() > 240
                || reference.source_title.contains('\0')
        })
    {
        return Err(IntegratorError::InvalidInput(
            "message contains an invalid chat reference".into(),
        ));
    }
    Ok(())
}

pub(super) type ContextReferenceRow = (
    String,
    String,
    Option<String>,
    String,
    i64,
    i64,
    i64,
    String,
    String,
    String,
);

pub(super) fn parse_context_reference_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ContextReferenceRow> {
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
    ))
}

pub(super) fn parse_context_reference(row: ContextReferenceRow) -> Result<TaskContextReference> {
    let (
        id,
        target_task_id,
        source_task_id,
        source_title,
        source_watermark,
        message_count,
        rendered_chars,
        rendered_sha256,
        rendered_markdown,
        created_at,
    ) = row;
    Ok(TaskContextReference {
        id: ContextReferenceId::from_str(&id).map_err(invalid_stored)?,
        target_task_id: TaskId::from_str(&target_task_id).map_err(invalid_stored)?,
        source_task_id: source_task_id
            .as_deref()
            .map(TaskId::from_str)
            .transpose()
            .map_err(invalid_stored)?,
        source_title,
        source_watermark: u64::try_from(source_watermark).map_err(invalid_stored)?,
        message_count: u32::try_from(message_count).map_err(invalid_stored)?,
        rendered_chars: u32::try_from(rendered_chars).map_err(invalid_stored)?,
        rendered_sha256,
        rendered_markdown,
        created_at: parse_time(&created_at)?,
    })
}

fn query_context_reference(
    connection: &Connection,
    reference_id: ContextReferenceId,
) -> Result<TaskContextReference> {
    let row = connection
        .query_row(
            "SELECT id, target_task_id, source_task_id, source_title, source_watermark, message_count, rendered_chars, rendered_sha256, rendered_markdown, created_at \
             FROM task_context_references WHERE id = ?1",
            [reference_id.to_string()],
            parse_context_reference_row,
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| IntegratorError::NotFound(format!("context reference {reference_id}")))?;
    parse_context_reference(row)
}
