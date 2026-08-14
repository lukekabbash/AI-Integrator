use super::*;

impl LocalStore {
    pub fn upsert_trusted_project(
        &self,
        display_name: &str,
        project_root: &Path,
        git_repository: Option<(&Path, &Path)>,
    ) -> Result<TrustedProject> {
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.chars().count() > 120 {
            return Err(IntegratorError::InvalidInput(
                "project display name must contain 1 to 120 characters".into(),
            ));
        }
        if !project_root.is_absolute()
            || git_repository
                .is_some_and(|(root, common)| !root.is_absolute() || !common.is_absolute())
        {
            return Err(IntegratorError::InvalidInput(
                "trusted project paths must be canonical absolute paths".into(),
            ));
        }
        let project_root = project_root.to_string_lossy().into_owned();
        let git_repository = git_repository.map(|(root, common)| {
            (
                root.to_string_lossy().into_owned(),
                common.to_string_lossy().into_owned(),
            )
        });
        let now = Utc::now();
        let connection = self.connection.lock();
        let existing = connection
            .query_row(
                "SELECT id, created_at FROM trusted_projects WHERE repository_root = ?1",
                [&project_root],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let (id, created_at) = match existing {
            Some((id, created_at)) => (
                ProjectId::from_str(&id).map_err(invalid_stored)?,
                parse_time(&created_at)?,
            ),
            None => (ProjectId::new(), now),
        };
        let transaction = connection.unchecked_transaction().map_err(storage_error)?;
        // `git_common_directory` remains populated for compatibility with the
        // original table constraint. Authoritative optional Git identity lives
        // in `project_git_repositories` from migration 13 onward.
        let legacy_common = git_repository
            .as_ref()
            .map_or(project_root.as_str(), |(_, common)| common.as_str());
        transaction
            .execute(
                "INSERT INTO trusted_projects(id, display_name, repository_root, git_common_directory, created_at, last_opened_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(repository_root) DO UPDATE SET display_name = excluded.display_name, git_common_directory = excluded.git_common_directory, last_opened_at = excluded.last_opened_at",
                params![id.to_string(), display_name, project_root, legacy_common, created_at.to_rfc3339(), now.to_rfc3339()],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM project_git_repositories WHERE project_id = ?1",
                [id.to_string()],
            )
            .map_err(storage_error)?;
        if let Some((root, common)) = &git_repository {
            transaction
                .execute(
                    "INSERT INTO project_git_repositories(project_id, repository_root, git_common_directory) VALUES (?1, ?2, ?3)",
                    params![id.to_string(), root, common],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(TrustedProject {
            id,
            display_name: display_name.to_owned(),
            repository_root: PathBuf::from(project_root),
            git_repository_root: git_repository.as_ref().map(|(root, _)| PathBuf::from(root)),
            git_common_directory: git_repository
                .as_ref()
                .map(|(_, common)| PathBuf::from(common)),
            created_at,
            last_opened_at: now,
        })
    }

    pub fn list_trusted_projects(&self) -> Result<Vec<TrustedProject>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT p.id, p.display_name, p.repository_root, g.repository_root, g.git_common_directory, p.created_at, p.last_opened_at FROM trusted_projects p LEFT JOIN project_git_repositories g ON g.project_id = p.id ORDER BY p.last_opened_at DESC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (id, display_name, root, git_root, common, created, opened) =
                row.map_err(storage_error)?;
            Ok(TrustedProject {
                id: ProjectId::from_str(&id).map_err(invalid_stored)?,
                display_name,
                repository_root: PathBuf::from(root),
                git_repository_root: git_root.map(PathBuf::from),
                git_common_directory: common.map(PathBuf::from),
                created_at: parse_time(&created)?,
                last_opened_at: parse_time(&opened)?,
            })
        })
        .collect()
    }

    /// Detaches a trusted project and deletes Integrator-owned history for it
    /// (tasks and cascaded session/projection rows). Never touches the folder
    /// on disk — filesystem deletion is an explicit host-layer choice.
    pub fn remove_trusted_project(&self, project_id: ProjectId) -> Result<TrustedProject> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let project = {
            let mut statement = transaction
                .prepare(
                    "SELECT p.id, p.display_name, p.repository_root, g.repository_root, g.git_common_directory, p.created_at, p.last_opened_at FROM trusted_projects p LEFT JOIN project_git_repositories g ON g.project_id = p.id WHERE p.id = ?1",
                )
                .map_err(storage_error)?;
            statement
                .query_row([project_id.to_string()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .optional()
                .map_err(storage_error)?
                .ok_or_else(|| IntegratorError::NotFound(format!("project {project_id}")))
                .and_then(
                    |(id, display_name, root, git_root, common, created, opened)| {
                        Ok(TrustedProject {
                            id: ProjectId::from_str(&id).map_err(invalid_stored)?,
                            display_name,
                            repository_root: PathBuf::from(root),
                            git_repository_root: git_root.map(PathBuf::from),
                            git_common_directory: common.map(PathBuf::from),
                            created_at: parse_time(&created)?,
                            last_opened_at: parse_time(&opened)?,
                        })
                    },
                )?
        };
        let project_root = project.repository_root.to_string_lossy().into_owned();
        // Tasks are path-linked rather than FK-linked; wipe them explicitly so
        // chat history leaves with the project instead of becoming orphaned.
        transaction
            .execute(
                "DELETE FROM tasks WHERE repository_path = ?1",
                [&project_root],
            )
            .map_err(storage_error)?;
        let changed = transaction
            .execute(
                "DELETE FROM trusted_projects WHERE id = ?1",
                [project_id.to_string()],
            )
            .map_err(storage_error)?;
        if changed == 0 {
            return Err(IntegratorError::NotFound(format!("project {project_id}")));
        }
        transaction.commit().map_err(storage_error)?;
        Ok(project)
    }

    /// Deletes Integrator-owned code-task history for an exact legacy
    /// repository path that has no trusted-project row. This never grants
    /// filesystem authority or removes the path itself.
    pub fn remove_project_history_by_repository_path(
        &self,
        repository_path: &Path,
    ) -> Result<usize> {
        let repository_path = repository_path.to_string_lossy();
        if repository_path.trim().is_empty() || repository_path.chars().count() > 4_096 {
            return Err(IntegratorError::InvalidInput(
                "legacy project repository path is invalid".into(),
            ));
        }
        self.connection
            .lock()
            .execute(
                "DELETE FROM tasks WHERE kind = 'code' AND repository_path = ?1",
                [repository_path.as_ref()],
            )
            .map_err(storage_error)
    }
}
