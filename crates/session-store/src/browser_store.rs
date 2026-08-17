use super::*;

/// One browser tab a chat had open, as it will be reopened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredBrowserTab {
    pub url: String,
    pub title: String,
}

impl LocalStore {
    /// Replaces the remembered tabs for one task. The whole list is written at
    /// once because that is what the caller has: a tab closing is the absence
    /// of a row, not an event to reconcile.
    pub fn set_browser_tabs(&self, task_id: TaskId, tabs: &[StoredBrowserTab]) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM browser_tabs WHERE task_id = ?1",
                [task_id.to_string()],
            )
            .map_err(storage_error)?;
        for (ordinal, tab) in tabs.iter().enumerate() {
            // A blank tab has nothing to reopen, and a page too long to be a
            // real address is not worth carrying between sessions.
            if tab.url.trim().is_empty() || tab.url.starts_with("about:") || tab.url.len() > 2048 {
                continue;
            }
            transaction
                .execute(
                    "INSERT INTO browser_tabs(task_id, ordinal, url, title, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        task_id.to_string(),
                        ordinal as i64,
                        tab.url,
                        tab.title,
                        now
                    ],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(())
    }

    /// The tabs a task had open, in the order they were in.
    pub fn browser_tabs(&self, task_id: TaskId) -> Result<Vec<StoredBrowserTab>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT url, title FROM browser_tabs WHERE task_id = ?1 ORDER BY ordinal ASC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([task_id.to_string()], |row| {
                Ok(StoredBrowserTab {
                    url: row.get(0)?,
                    title: row.get(1)?,
                })
            })
            .map_err(storage_error)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage_error)
    }
}
