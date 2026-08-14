use super::*;

impl LocalStore {
    pub fn upsert_provider_session(&self, session: &ProviderSession) -> Result<()> {
        if session.provider_thread_id.trim().is_empty() {
            return Err(IntegratorError::InvalidInput(
                "provider thread id cannot be empty".into(),
            ));
        }
        self.connection
            .lock()
            .execute(
                "INSERT INTO provider_sessions(id, task_id, provider, provider_thread_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(provider, provider_thread_id) DO UPDATE SET task_id = excluded.task_id, updated_at = excluded.updated_at",
                params![
                    session.id.to_string(), session.task_id.to_string(), session.provider.as_str(),
                    session.provider_thread_id, session.created_at.to_rfc3339(), session.updated_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn insert_runtime_session(&self, session: &RuntimeSession) -> Result<()> {
        self.connection
            .lock()
            .execute(
                "INSERT INTO runtime_sessions(id, task_id, provider_session_id, process_id, status, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    session.id.to_string(), session.task_id.to_string(), session.provider_session_id.map(|id| id.to_string()),
                    session.process_id, session.status, session.started_at.to_rfc3339(), session.ended_at.map(|time| time.to_rfc3339()),
                ],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    /// Reconcile process-owned sessions left unfinished by a prior app exit.
    /// App startup calls this only after single-instance ownership is acquired,
    /// so a secondary database reader cannot interrupt a live process record.
    pub fn interrupt_unfinished_runtime_sessions(&self) -> Result<usize> {
        self.connection
            .lock()
            .execute(
                "UPDATE runtime_sessions SET status='interrupted',ended_at=?1 WHERE ended_at IS NULL",
                [Utc::now().to_rfc3339()],
            )
            .map_err(storage_error)
    }

    pub fn export(&self) -> Result<LocalExport> {
        Ok(LocalExport {
            schema_version: integrator_core::DOMAIN_SCHEMA_VERSION,
            exported_at: Utc::now(),
            projects: self.list_trusted_projects()?,
            tasks: self.list_tasks()?,
            settings: self.list_settings()?,
            provider_sessions: self.list_provider_sessions()?,
            runtime_sessions: self.list_runtime_sessions()?,
            provider_resume_states: self.list_provider_resume_states()?,
            composer_drafts: self.list_composer_drafts()?,
            queued_messages: self.list_all_queued_messages()?,
            context_references: self.list_all_context_references()?,
            memories: self.list_memories()?,
        })
    }

    pub fn upsert_provider_resume_state(&self, state: &ProviderResumeState) -> Result<()> {
        if state.session_ref.trim().is_empty() || state.session_ref.len() > 512 {
            return Err(IntegratorError::InvalidInput(
                "provider resume identity is invalid".into(),
            ));
        }
        if !state.repository_root.is_absolute() {
            return Err(IntegratorError::InvalidInput(
                "provider resume repository must be absolute".into(),
            ));
        }
        self.connection
            .lock()
            .execute(
                "INSERT INTO provider_resume_states(task_id,provider,session_ref,repository_root,permission,delegation,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(task_id) DO UPDATE SET provider=excluded.provider,session_ref=excluded.session_ref,repository_root=excluded.repository_root,permission=excluded.permission,delegation=excluded.delegation,updated_at=excluded.updated_at",
                params![
                    state.task_id.to_string(),
                    state.provider.as_str(),
                    state.session_ref,
                    state.repository_root.to_string_lossy(),
                    state.permission,
                    state.delegation,
                    state.updated_at.to_rfc3339(),
                ],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn clear_provider_resume_state(&self, task_id: TaskId) -> Result<()> {
        let connection = self.connection.lock();
        connection
            .execute(
                "DELETE FROM provider_resume_states WHERE task_id = ?1",
                [task_id.to_string()],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    pub fn provider_resume_state(&self, task_id: TaskId) -> Result<Option<ProviderResumeState>> {
        let row = self
            .connection
            .lock()
            .query_row(
                "SELECT provider,session_ref,repository_root,permission,delegation,updated_at FROM provider_resume_states WHERE task_id=?1",
                [task_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        row.map(
            |(provider, session_ref, repository_root, permission, delegation, updated_at)| {
                Ok(ProviderResumeState {
                    task_id,
                    provider: ProviderKind::from_str(&provider)?,
                    session_ref,
                    repository_root: PathBuf::from(repository_root),
                    permission,
                    delegation,
                    updated_at: parse_time(&updated_at)?,
                })
            },
        )
        .transpose()
    }

    pub fn list_provider_resume_states(&self) -> Result<Vec<ProviderResumeState>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT task_id,provider,session_ref,repository_root,permission,delegation,updated_at FROM provider_resume_states ORDER BY updated_at DESC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (
                task_id,
                provider,
                session_ref,
                repository_root,
                permission,
                delegation,
                updated_at,
            ) = row.map_err(storage_error)?;
            Ok(ProviderResumeState {
                task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                provider: ProviderKind::from_str(&provider)?,
                session_ref,
                repository_root: PathBuf::from(repository_root),
                permission,
                delegation,
                updated_at: parse_time(&updated_at)?,
            })
        })
        .collect()
    }

    fn list_all_queued_messages(&self) -> Result<Vec<QueuedMessage>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, task_id, prompt, attachments_json, context_references_json, runtime, model, effort, permission, delegation, native_action_id, position, state, created_at, updated_at FROM queued_messages ORDER BY task_id, position, created_at",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_queued_message_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_queued_message(row.map_err(storage_error)?))
            .collect()
    }

    fn list_all_context_references(&self) -> Result<Vec<TaskContextReference>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, target_task_id, source_task_id, source_title, source_watermark, message_count, rendered_chars, rendered_sha256, rendered_markdown, created_at FROM task_context_references ORDER BY created_at, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], parse_context_reference_row)
            .map_err(storage_error)?;
        rows.map(|row| parse_context_reference(row.map_err(storage_error)?))
            .collect()
    }

    pub fn list_provider_sessions(&self) -> Result<Vec<ProviderSession>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, task_id, provider, provider_thread_id, created_at, updated_at FROM provider_sessions ORDER BY updated_at DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, task_id, provider, thread, created, updated) = row.map_err(storage_error)?;
            Ok(ProviderSession {
                id: ProviderSessionId::from_str(&id).map_err(invalid_stored)?,
                task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                provider: ProviderKind::from_str(&provider)?,
                provider_thread_id: thread,
                created_at: parse_time(&created)?,
                updated_at: parse_time(&updated)?,
            })
        })
        .collect()
    }

    pub fn list_runtime_sessions(&self) -> Result<Vec<RuntimeSession>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, task_id, provider_session_id, process_id, status, started_at, ended_at FROM runtime_sessions ORDER BY started_at DESC")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, task_id, provider_session_id, process_id, status, started, ended) =
                row.map_err(storage_error)?;
            Ok(RuntimeSession {
                id: RuntimeSessionId::from_str(&id).map_err(invalid_stored)?,
                task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                provider_session_id: provider_session_id
                    .map(|id| ProviderSessionId::from_str(&id).map_err(invalid_stored))
                    .transpose()?,
                process_id,
                status,
                started_at: parse_time(&started)?,
                ended_at: ended.map(|time| parse_time(&time)).transpose()?,
            })
        })
        .collect()
    }
}
