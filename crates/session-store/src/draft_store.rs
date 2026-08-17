use super::*;

impl LocalStore {
    /// Creates the first durable task and moves its project-level new-chat
    /// draft in the same transaction. A crash can therefore leave the draft
    /// on either side of this boundary, but never detached from both owners.
    pub fn create_task_with_project_draft(
        &self,
        input: NewTask,
        draft: ComposerDraft,
    ) -> Result<Task> {
        let task = build_task(input)?;
        let draft = normalize_composer_draft(draft)?;
        let project_id = match draft.owner {
            ComposerDraftOwner::NewChat { project_id } => project_id,
            ComposerDraftOwner::Task { .. } => {
                return Err(IntegratorError::InvalidInput(
                    "only a new-chat draft can be promoted while creating a task".into(),
                ));
            }
        };
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let project_root = transaction
            .query_row(
                "SELECT repository_root FROM trusted_projects WHERE id = ?1",
                [project_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("project {project_id}")))?;
        if task.repository_path.as_deref() != Some(Path::new(&project_root)) {
            return Err(IntegratorError::InvalidInput(
                "new-chat draft project does not own the task repository".into(),
            ));
        }
        insert_task_row(&transaction, &task)?;

        let mut task_draft = draft.clone();
        task_draft.owner = ComposerDraftOwner::Task { task_id: task.id };
        write_composer_draft(&transaction, &task_draft)?;

        let mut project_tombstone = draft;
        project_tombstone.prompt.clear();
        project_tombstone.attachments.clear();
        project_tombstone.context_references.clear();
        project_tombstone.selection_start = 0;
        project_tombstone.selection_end = 0;
        let (project_draft_key, _, _) = draft_identity(&project_tombstone.owner);
        transaction
            .execute(
                "DELETE FROM composer_drafts WHERE draft_key = ?1 AND revision <= ?2",
                params![project_draft_key, project_tombstone.revision as i64],
            )
            .map_err(storage_error)?;
        write_composer_draft(&transaction, &project_tombstone)?;
        transaction.commit().map_err(storage_error)?;
        Ok(task)
    }

    pub fn upsert_composer_draft(&self, draft: ComposerDraft) -> Result<()> {
        let draft = normalize_composer_draft(draft)?;
        let connection = self.connection.lock();
        ensure_draft_owner(&connection, &draft.owner)?;
        write_composer_draft(&connection, &draft)?;
        Ok(())
    }

    pub fn list_composer_drafts(&self) -> Result<Vec<ComposerDraft>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT project_id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, selection_start, selection_end, revision, updated_at FROM composer_drafts ORDER BY updated_at DESC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (
                project_id,
                task_id,
                prompt,
                attachments,
                context_references,
                runtime,
                model,
                effort,
                permission,
                delegation,
                selection_start,
                selection_end,
                revision,
                updated_at,
            ) = row.map_err(storage_error)?;
            let owner = match (project_id, task_id) {
                (Some(project_id), None) => ComposerDraftOwner::NewChat {
                    project_id: ProjectId::from_str(&project_id).map_err(invalid_stored)?,
                },
                (None, Some(task_id)) => ComposerDraftOwner::Task {
                    task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                },
                _ => return Err(invalid_stored("composer draft has invalid ownership")),
            };
            Ok(ComposerDraft {
                owner,
                prompt,
                attachments: serde_json::from_str::<Vec<ComposerDraftAttachment>>(&attachments)
                    .map_err(invalid_stored)?,
                context_references: serde_json::from_str::<Vec<ChatContextReference>>(
                    &context_references,
                )
                .map_err(invalid_stored)?,
                runtime,
                model,
                effort,
                permission,
                delegation,
                selection_start: u32::try_from(selection_start).map_err(invalid_stored)?,
                selection_end: u32::try_from(selection_end).map_err(invalid_stored)?,
                revision: u64::try_from(revision).map_err(invalid_stored)?,
                updated_at: parse_time(&updated_at)?,
            })
        })
        .collect()
    }
}

fn normalize_composer_draft(mut draft: ComposerDraft) -> Result<ComposerDraft> {
    const PROMPT_LIMIT: usize = 2 * 1024 * 1024;
    const ATTACHMENT_LIMIT: usize = 64;
    if draft.prompt.len() > PROMPT_LIMIT {
        return Err(IntegratorError::InvalidInput(
            "composer draft must not exceed 2 MiB".into(),
        ));
    }
    if draft.attachments.len() > ATTACHMENT_LIMIT {
        return Err(IntegratorError::InvalidInput(format!(
            "composer draft must not contain more than {ATTACHMENT_LIMIT} attachments"
        )));
    }
    validate_context_references(&draft.context_references)?;
    for attachment in &draft.attachments {
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
                "composer draft contains an invalid attachment reference".into(),
            ));
        }
    }
    let runtime = draft.runtime.trim();
    if runtime.is_empty() || runtime.chars().count() > 64 {
        return Err(IntegratorError::InvalidInput(
            "composer runtime must contain 1 to 64 characters".into(),
        ));
    }
    let model = draft.model.trim();
    if model.is_empty() || model.chars().count() > 120 {
        return Err(IntegratorError::InvalidInput(
            "composer model must contain 1 to 120 characters".into(),
        ));
    }
    draft.runtime = runtime.to_owned();
    draft.model = model.to_owned();
    draft.effort = normalize_optional_text(draft.effort, 64)?;
    if !matches!(
        draft.permission.as_str(),
        "read-only" | "project-write" | "ask" | "auto" | "full-access"
    ) {
        return Err(IntegratorError::InvalidInput(
            "invalid composer permission profile".into(),
        ));
    }
    if !matches!(
        draft.delegation.as_str(),
        "off" | "manual" | "balanced" | "budget-first"
    ) {
        return Err(IntegratorError::InvalidInput(
            "invalid composer delegation mode".into(),
        ));
    }
    let prompt_units = draft.prompt.encode_utf16().count();
    if draft.selection_start as usize > prompt_units
        || draft.selection_end as usize > prompt_units
        || draft.selection_start > draft.selection_end
    {
        return Err(IntegratorError::InvalidInput(
            "composer selection is outside the draft".into(),
        ));
    }
    if draft.revision == 0 || draft.revision >= i64::MAX as u64 {
        return Err(IntegratorError::InvalidInput(
            "composer draft revision is outside the supported range".into(),
        ));
    }
    draft.updated_at = Utc::now();
    Ok(draft)
}

fn draft_identity(owner: &ComposerDraftOwner) -> (String, Option<String>, Option<String>) {
    match owner {
        ComposerDraftOwner::NewChat { project_id } => (
            format!("project:{project_id}"),
            Some(project_id.to_string()),
            None,
        ),
        ComposerDraftOwner::Task { task_id } => {
            (format!("task:{task_id}"), None, Some(task_id.to_string()))
        }
    }
}

fn ensure_draft_owner(connection: &Connection, owner: &ComposerDraftOwner) -> Result<()> {
    let exists = match owner {
        ComposerDraftOwner::NewChat { project_id } => connection
            .query_row(
                "SELECT 1 FROM trusted_projects WHERE id = ?1",
                [project_id.to_string()],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage_error)?
            .is_some(),
        ComposerDraftOwner::Task { task_id } => connection
            .query_row(
                "SELECT 1 FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage_error)?
            .is_some(),
    };
    if exists {
        Ok(())
    } else {
        Err(IntegratorError::NotFound("composer draft owner".into()))
    }
}

fn write_composer_draft(connection: &Connection, draft: &ComposerDraft) -> Result<()> {
    let (draft_key, project_id, task_id) = draft_identity(&draft.owner);
    let attachments = serde_json::to_string(&draft.attachments)?;
    let context_references = serde_json::to_string(&draft.context_references)?;
    connection
        .execute(
            r#"
            INSERT INTO composer_drafts(
                draft_key, project_id, task_id, prompt, attachments_json, context_references_json,
                runtime, model, effort, permission, delegation, selection_start, selection_end,
                revision, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(draft_key) DO UPDATE SET
                project_id=excluded.project_id,
                task_id=excluded.task_id,
                prompt=excluded.prompt,
                attachments_json=excluded.attachments_json,
                context_references_json=excluded.context_references_json,
                runtime=excluded.runtime,
                model=excluded.model,
                effort=excluded.effort,
                permission=excluded.permission,
                delegation=excluded.delegation,
                selection_start=excluded.selection_start,
                selection_end=excluded.selection_end,
                revision=excluded.revision,
                updated_at=excluded.updated_at
            WHERE excluded.revision > composer_drafts.revision
            "#,
            params![
                draft_key,
                project_id,
                task_id,
                &draft.prompt,
                attachments,
                context_references,
                &draft.runtime,
                &draft.model,
                &draft.effort,
                &draft.permission,
                &draft.delegation,
                i64::from(draft.selection_start),
                i64::from(draft.selection_end),
                draft.revision as i64,
                draft.updated_at.to_rfc3339(),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}
