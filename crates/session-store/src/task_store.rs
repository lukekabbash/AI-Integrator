use super::*;

impl LocalStore {
    pub fn create_task(&self, input: NewTask) -> Result<Task> {
        let task = build_task(input)?;
        insert_task_row(&self.connection.lock(), &task)?;
        Ok(task)
    }

    /// Live navigation set: non-archived tasks ordered for the sidebar.
    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        self.query_tasks(
            "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC",
            [],
        )
    }

    /// Every task including archived rows. Used for full local backups only —
    /// workspace bootstrap and `task_list` stay on [`Self::list_tasks`].
    pub fn list_all_tasks(&self) -> Result<Vec<Task>> {
        self.query_tasks(
            "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks ORDER BY pinned DESC, updated_at DESC",
            [],
        )
    }

    /// Paginated archived root chats for Archive UI. Cursor is opaque
    /// `updated_at\\tid` keyset pagination (newest first).
    pub fn list_archived_tasks(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ArchivedTaskPage> {
        let limit = limit.clamp(1, 100);
        let connection = self.connection.lock();
        let total = connection
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE archived = 1 AND parent_task_id IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)? as u64;
        let fetch_limit = (limit + 1) as i64;
        let rows = if let Some(cursor) = cursor {
            let (updated_at, id) = parse_archived_cursor(cursor)?;
            let mut statement = connection
                .prepare(
                    "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE archived = 1 AND parent_task_id IS NULL AND (updated_at < ?1 OR (updated_at = ?1 AND id < ?2)) ORDER BY updated_at DESC, id DESC LIMIT ?3",
                )
                .map_err(storage_error)?;
            let mapped = statement
                .query_map(params![updated_at, id, fetch_limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, bool>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                })
                .map_err(storage_error)?;
            mapped
                .map(|row| parse_task_row(row.map_err(storage_error)?))
                .collect::<Result<Vec<_>>>()?
        } else {
            let mut statement = connection
                .prepare(
                    "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE archived = 1 AND parent_task_id IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?1",
                )
                .map_err(storage_error)?;
            let mapped = statement
                .query_map(params![fetch_limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, bool>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                })
                .map_err(storage_error)?;
            mapped
                .map(|row| parse_task_row(row.map_err(storage_error)?))
                .collect::<Result<Vec<_>>>()?
        };
        let next_cursor = if rows.len() > limit {
            rows.get(limit - 1).map(|task| {
                format_archived_cursor(&task.updated_at.to_rfc3339(), &task.id.to_string())
            })
        } else {
            None
        };
        Ok(ArchivedTaskPage {
            tasks: rows.into_iter().take(limit).collect(),
            next_cursor,
            total,
        })
    }

    fn query_tasks(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<Task>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(sql).map_err(storage_error)?;
        let rows = statement
            .query_map(params, |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, bool>(6)?,
                    row.get::<_, bool>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| parse_task_row(row.map_err(storage_error)?))
            .collect()
    }

    pub fn update_task_state(&self, task_id: TaskId, state: TaskState) -> Result<Task> {
        let now = Utc::now();
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE tasks SET state = ?1, updated_at = ?2 WHERE id = ?3",
                params![state.as_str(), now.to_rfc3339(), task_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("task {task_id}")));
        }
        self.get_task(task_id)
    }

    pub fn update_task_metadata(
        &self,
        task_id: TaskId,
        title: Option<String>,
        pinned: Option<bool>,
        archived: Option<bool>,
    ) -> Result<Task> {
        let title = title.map(|value| value.trim().to_owned());
        if title
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.chars().count() > 240)
        {
            return Err(IntegratorError::InvalidInput(
                "task title must contain 1 to 240 characters".into(),
            ));
        }
        let now = Utc::now();
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE tasks SET title = COALESCE(?1, title), pinned = COALESCE(?2, pinned), archived = COALESCE(?3, archived), updated_at = ?4 WHERE id = ?5",
                params![title, pinned, archived, now.to_rfc3339(), task_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("task {task_id}")));
        }
        self.get_task(task_id)
    }

    /// Permanently deletes one chat and cascaded Integrator-owned rows
    /// (sessions, projections, queue, drafts). Never touches the project folder.
    pub fn remove_task(&self, task_id: TaskId) -> Result<Task> {
        let task = self.get_task(task_id)?;
        let changed = self
            .connection
            .lock()
            .execute("DELETE FROM tasks WHERE id = ?1", [task_id.to_string()])
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("task {task_id}")));
        }
        Ok(task)
    }

    /// Replace a temporary title only while it still has the expected value.
    /// A concurrent manual rename therefore always wins over background naming.
    pub fn compare_and_set_task_title(
        &self,
        task_id: TaskId,
        expected_title: &str,
        title: &str,
    ) -> Result<Option<Task>> {
        let expected_title = expected_title.trim();
        let title = title.trim();
        if expected_title.is_empty() || expected_title.chars().count() > 240 {
            return Err(IntegratorError::InvalidInput(
                "expected task title must contain 1 to 240 characters".into(),
            ));
        }
        if title.is_empty() || title.chars().count() > 240 {
            return Err(IntegratorError::InvalidInput(
                "task title must contain 1 to 240 characters".into(),
            ));
        }
        let now = Utc::now();
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE tasks SET title = ?1, updated_at = ?2 WHERE id = ?3 AND title = ?4",
                params![title, now.to_rfc3339(), task_id.to_string(), expected_title],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            self.get_task(task_id)?;
            return Ok(None);
        }
        self.get_task(task_id).map(Some)
    }

    /// Persistently claim the one automatic naming attempt allowed for a task.
    /// The insert is conditional on the placeholder still being present, so a
    /// renderer retry, app restart, or concurrent manual rename cannot spend a
    /// second provider call.
    pub fn claim_task_title_generation(
        &self,
        task_id: TaskId,
        expected_title: &str,
    ) -> Result<bool> {
        let expected_title = expected_title.trim();
        if expected_title.is_empty() || expected_title.chars().count() > 240 {
            return Err(IntegratorError::InvalidInput(
                "expected task title must contain 1 to 240 characters".into(),
            ));
        }
        let changed = self
            .connection
            .lock()
            .execute(
                "INSERT OR IGNORE INTO task_title_jobs(task_id, started_at) SELECT id, ?1 FROM tasks WHERE id = ?2 AND title = ?3",
                params![Utc::now().to_rfc3339(), task_id.to_string(), expected_title],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            self.get_task(task_id)?;
        }
        Ok(changed == 1)
    }

    /// Claim one provider call for a specific staged-diff snapshot. Completed
    /// results are reused, while an unfinished claim fails closed so retries or
    /// concurrent clicks cannot multiply provider spend.
    pub fn claim_commit_message_generation(
        &self,
        task_id: TaskId,
        provider: &str,
        diff_fingerprint: &str,
    ) -> Result<CommitMessageGenerationClaim> {
        let provider = provider.trim();
        let diff_fingerprint = diff_fingerprint.trim();
        if provider.is_empty() || provider.chars().count() > 64 {
            return Err(IntegratorError::InvalidInput(
                "commit-message provider must contain 1 to 64 characters".into(),
            ));
        }
        if diff_fingerprint.is_empty() || diff_fingerprint.chars().count() > 128 {
            return Err(IntegratorError::InvalidInput(
                "commit-message fingerprint must contain 1 to 128 characters".into(),
            ));
        }

        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let existing = transaction
            .query_row(
                "SELECT message, started_at FROM commit_message_jobs WHERE task_id = ?1 AND provider = ?2 AND diff_fingerprint = ?3",
                params![task_id.to_string(), provider, diff_fingerprint],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        if let Some((message, started_at)) = existing {
            if let Some(message) = message {
                transaction.commit().map_err(storage_error)?;
                return Ok(CommitMessageGenerationClaim::Cached(message));
            }
            // Failed generations release their claim explicitly, but a crash
            // mid-generation would otherwise pin InProgress forever. Callers
            // time out well within this window, so an old unfinished claim is
            // orphaned, not racing.
            let stale = DateTime::parse_from_rfc3339(&started_at)
                .map(|started| {
                    Utc::now().signed_duration_since(started.with_timezone(&Utc))
                        > chrono::Duration::seconds(COMMIT_MESSAGE_CLAIM_TTL_SECONDS)
                })
                .unwrap_or(true);
            if !stale {
                transaction.commit().map_err(storage_error)?;
                return Ok(CommitMessageGenerationClaim::InProgress);
            }
            transaction
                .execute(
                    "DELETE FROM commit_message_jobs WHERE task_id = ?1 AND provider = ?2 AND diff_fingerprint = ?3 AND message IS NULL",
                    params![task_id.to_string(), provider, diff_fingerprint],
                )
                .map_err(storage_error)?;
        }
        let changed = transaction
            .execute(
                "INSERT INTO commit_message_jobs(task_id, provider, diff_fingerprint, message, started_at) SELECT id, ?1, ?2, NULL, ?3 FROM tasks WHERE id = ?4",
                params![provider, diff_fingerprint, Utc::now().to_rfc3339(), task_id.to_string()],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        if changed == 0 {
            drop(connection);
            self.get_task(task_id)?;
        }
        Ok(CommitMessageGenerationClaim::Claimed)
    }

    pub fn complete_commit_message_generation(
        &self,
        task_id: TaskId,
        provider: &str,
        diff_fingerprint: &str,
        message: &str,
    ) -> Result<()> {
        let message = message.trim();
        if message.is_empty()
            || message.chars().count() > 72
            || message.chars().any(char::is_control)
        {
            return Err(IntegratorError::InvalidInput(
                "commit message must contain 1 to 72 printable characters".into(),
            ));
        }
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE commit_message_jobs SET message = ?1 WHERE task_id = ?2 AND provider = ?3 AND diff_fingerprint = ?4 AND message IS NULL",
                params![message, task_id.to_string(), provider, diff_fingerprint],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::InvalidInput(
                "commit-message generation was not claimed".into(),
            ));
        }
        Ok(())
    }

    /// Release an unfinished claim so a failed generation can be retried
    /// immediately instead of waiting out the stale-claim window. Completed
    /// (cached) results are never removed.
    pub fn abandon_commit_message_generation(
        &self,
        task_id: TaskId,
        provider: &str,
        diff_fingerprint: &str,
    ) -> Result<()> {
        self.connection
            .lock()
            .execute(
                "DELETE FROM commit_message_jobs WHERE task_id = ?1 AND provider = ?2 AND diff_fingerprint = ?3 AND message IS NULL",
                params![task_id.to_string(), provider, diff_fingerprint],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    /// Persist the composer's last provider/model/effort selection for this chat.
    pub fn update_task_routing(
        &self,
        task_id: TaskId,
        runtime: &str,
        model: &str,
        effort: Option<&str>,
    ) -> Result<Task> {
        let runtime = normalize_optional_text(Some(runtime.to_owned()), 64)?
            .ok_or_else(|| IntegratorError::InvalidInput("runtime is required".into()))?;
        let model = normalize_optional_text(Some(model.to_owned()), 120)?
            .ok_or_else(|| IntegratorError::InvalidInput("model is required".into()))?;
        let effort = normalize_optional_text(effort.map(str::to_owned), 64)?;
        let now = Utc::now();
        let connection = self.connection.lock();
        let changed = connection
            .execute(
                "UPDATE tasks SET runtime = ?1, model = ?2, effort = ?3, updated_at = ?4 WHERE id = ?5",
                params![
                    runtime,
                    model,
                    effort,
                    now.to_rfc3339(),
                    task_id.to_string()
                ],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("task {task_id}")));
        }
        drop(connection);
        self.get_task(task_id)
    }

    pub fn get_task(&self, task_id: TaskId) -> Result<Task> {
        let connection = self.connection.lock();
        let row = connection
            .query_row(
                "SELECT id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, bool>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| IntegratorError::NotFound(format!("task {task_id}")))?;
        parse_task_row(row)
    }
}

fn format_archived_cursor(updated_at: &str, id: &str) -> String {
    format!("{updated_at}\t{id}")
}

fn parse_archived_cursor(cursor: &str) -> Result<(String, String)> {
    let (updated_at, id) = cursor
        .split_once('\t')
        .ok_or_else(|| IntegratorError::InvalidInput("archived task cursor is invalid".into()))?;
    if updated_at.is_empty() || id.is_empty() {
        return Err(IntegratorError::InvalidInput(
            "archived task cursor is invalid".into(),
        ));
    }
    Ok((updated_at.to_owned(), id.to_owned()))
}

type StoredTaskRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    bool,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);

fn parse_task_row(row: StoredTaskRow) -> Result<Task> {
    let (
        id,
        kind,
        title,
        repository,
        worktree,
        state,
        pinned,
        archived,
        runtime,
        model,
        effort,
        parent_task_id,
        created,
        updated,
    ) = row;
    Ok(Task {
        id: TaskId::from_str(&id).map_err(invalid_stored)?,
        kind: TaskKind::from_str(&kind)?,
        title,
        repository_path: repository.map(Into::into),
        worktree_path: worktree.map(Into::into),
        state: TaskState::from_str(&state)?,
        pinned,
        archived,
        runtime,
        model,
        effort,
        parent_task_id: parent_task_id
            .as_deref()
            .map(TaskId::from_str)
            .transpose()
            .map_err(invalid_stored)?,
        created_at: parse_time(&created)?,
        updated_at: parse_time(&updated)?,
    })
}

pub(crate) fn build_task(input: NewTask) -> Result<Task> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 240 {
        return Err(IntegratorError::InvalidInput(
            "task title must contain 1 to 240 characters".into(),
        ));
    }
    if input.kind == TaskKind::Chat
        && (input.repository_path.is_some()
            || input.worktree_path.is_some()
            || input.parent_task_id.is_some())
    {
        return Err(IntegratorError::InvalidInput(
            "Chat tasks cannot own a repository, worktree, or parent task".into(),
        ));
    }
    let now = Utc::now();
    Ok(Task {
        id: TaskId::new(),
        kind: input.kind,
        title: title.to_owned(),
        repository_path: input.repository_path,
        worktree_path: input.worktree_path,
        state: TaskState::Draft,
        pinned: false,
        archived: false,
        runtime: normalize_optional_text(input.runtime, 64)?,
        model: normalize_optional_text(input.model, 120)?,
        effort: normalize_optional_text(input.effort, 64)?,
        parent_task_id: input.parent_task_id,
        created_at: now,
        updated_at: now,
    })
}

pub(crate) fn insert_task_row(connection: &Connection, task: &Task) -> Result<()> {
    connection
        .execute(
            "INSERT INTO tasks(id, kind, title, repository_path, worktree_path, state, pinned, archived, runtime, model, effort, parent_task_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                task.id.to_string(),
                task.kind.as_str(),
                &task.title,
                path_text(task.repository_path.as_deref()),
                path_text(task.worktree_path.as_deref()),
                task.state.as_str(),
                task.pinned,
                task.archived,
                &task.runtime,
                &task.model,
                &task.effort,
                task.parent_task_id.map(|id| id.to_string()),
                task.created_at.to_rfc3339(),
                task.updated_at.to_rfc3339(),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}
