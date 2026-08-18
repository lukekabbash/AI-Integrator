use std::collections::HashSet;

use super::*;

/// How many retired tabs are kept across every group. Old enough to have been
/// forgotten, small enough that the table never becomes a second history.
const RECENT_TAB_CAP: usize = 200;

/// One browser tab a chat had open, as it will be reopened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredBrowserTab {
    pub url: String,
    pub title: String,
    /// The site's icon as a `data:` URL, when one was resolved. Kept so a
    /// restored strip shows icons before any page has loaded.
    pub favicon: Option<String>,
    /// The popout window the tab lived in, or `None` for a tab in the pane.
    pub window_id: Option<String>,
    /// Position within that window's strip. Meaningless without `window_id`.
    pub window_order: Option<u32>,
    /// When the tab was last looked at, for cleanup to judge staleness by.
    pub last_touched_at: Option<DateTime<Utc>>,
}

/// A popped-out browser window, remembered so a restart can put it back where
/// it was rather than dropping the person's layout on the floor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredBrowserWindow {
    /// The Tauri window label, `browser-window-<hex>`.
    pub id: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub maximized: bool,
    /// Best-effort monitor name, so a restore can tell "off screen" from
    /// "on the other screen".
    pub monitor: Option<String>,
    /// Group ids collapsed inside this window.
    pub collapsed_groups: Vec<String>,
    pub last_focused_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A tab that has left the strip but can still be brought back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRecentTab {
    pub task_id: TaskId,
    /// The strip group the tab belonged to (`chat`, `path:…`, `project:…`).
    /// `browser_tabs` has no group column, so callers supply it.
    pub group_id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub closed_at: DateTime<Utc>,
    /// `stale`, `over-cap` or `closed`.
    pub reason: String,
}

/// A popped-out tab as cleanup sees it: enough to retire it and to write the
/// recent row that replaces it.
struct PoppedRow {
    task_id: TaskId,
    ordinal: i64,
    url: String,
    title: String,
    favicon: Option<String>,
    last_touched_at: Option<DateTime<Utc>>,
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
            // Tabs are written as the person moves them, which can beat the
            // debounced geometry write for a window they just tore off. Stub
            // the window row so the reference holds; geometry fills in later.
            if let Some(window_id) = tab.window_id.as_deref() {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO browser_windows(\
                           id, maximized, collapsed_groups, last_focused_at, updated_at) \
                         VALUES (?1, 0, '[]', ?2, ?2)",
                        params![window_id, now],
                    )
                    .map_err(storage_error)?;
            }
            transaction
                .execute(
                    "INSERT INTO browser_tabs(\
                       task_id, ordinal, url, title, updated_at, favicon, \
                       window_id, window_order, last_touched_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        task_id.to_string(),
                        ordinal as i64,
                        tab.url,
                        tab.title,
                        now,
                        tab.favicon,
                        tab.window_id,
                        tab.window_order.map(i64::from),
                        tab.last_touched_at.map(|time| time.to_rfc3339()),
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
                "SELECT url, title, favicon, window_id, window_order, last_touched_at \
                 FROM browser_tabs WHERE task_id = ?1 ORDER BY ordinal ASC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([task_id.to_string()], |row| {
                Ok((
                    StoredBrowserTab {
                        url: row.get(0)?,
                        title: row.get(1)?,
                        favicon: row.get(2)?,
                        window_id: row.get(3)?,
                        window_order: row.get::<_, Option<i64>>(4)?.map(|value| value as u32),
                        last_touched_at: None,
                    },
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(storage_error)?;
        let mut tabs = Vec::new();
        for row in rows {
            let (mut tab, touched) = row.map_err(storage_error)?;
            tab.last_touched_at = touched.as_deref().map(parse_time).transpose()?;
            tabs.push(tab);
        }
        Ok(tabs)
    }

    /// Every popped-out tab in the store, for a restart to rebuild windows
    /// from without walking task by task.
    pub fn browser_tabs_all_popped(&self) -> Result<Vec<(TaskId, StoredBrowserTab)>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT task_id, url, title, favicon, window_id, window_order, last_touched_at \
                 FROM browser_tabs WHERE window_id IS NOT NULL \
                 ORDER BY window_id ASC, window_order ASC, task_id ASC, ordinal ASC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    StoredBrowserTab {
                        url: row.get(1)?,
                        title: row.get(2)?,
                        favicon: row.get(3)?,
                        window_id: row.get(4)?,
                        window_order: row.get::<_, Option<i64>>(5)?.map(|value| value as u32),
                        last_touched_at: None,
                    },
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(storage_error)?;
        let mut tabs = Vec::new();
        for row in rows {
            let (task_id, mut tab, touched) = row.map_err(storage_error)?;
            tab.last_touched_at = touched.as_deref().map(parse_time).transpose()?;
            tabs.push((TaskId::from_str(&task_id).map_err(invalid_stored)?, tab));
        }
        Ok(tabs)
    }

    /// Writes the whole set of popout windows. Windows absent from the list
    /// are gone; the rest are updated in place rather than deleted and
    /// reinserted, because deleting a row would null out the `window_id` of
    /// every tab that still belongs to it.
    pub fn set_browser_windows(&self, windows: &[StoredBrowserWindow]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let keep: HashSet<&str> = windows.iter().map(|window| window.id.as_str()).collect();
        let existing = {
            let mut statement = transaction
                .prepare("SELECT id FROM browser_windows")
                .map_err(storage_error)?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(storage_error)?;
            ids.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage_error)?
        };
        for id in existing {
            if !keep.contains(id.as_str()) {
                transaction
                    .execute("DELETE FROM browser_windows WHERE id = ?1", [&id])
                    .map_err(storage_error)?;
            }
        }
        for window in windows {
            write_browser_window(&transaction, window)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(())
    }

    /// Writes one window, leaving the others alone. What a move, resize or
    /// focus reports.
    pub fn upsert_browser_window(&self, window: &StoredBrowserWindow) -> Result<()> {
        let connection = self.connection.lock();
        write_browser_window(&connection, window)
    }

    /// The remembered popout windows, most recently focused first — the order
    /// a restore should rebuild them in.
    pub fn browser_windows(&self) -> Result<Vec<StoredBrowserWindow>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, x, y, width, height, maximized, monitor, collapsed_groups, \
                        last_focused_at, updated_at \
                 FROM browser_windows ORDER BY last_focused_at DESC, id ASC",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    StoredBrowserWindow {
                        id: row.get(0)?,
                        x: row.get::<_, Option<i64>>(1)?.map(|value| value as i32),
                        y: row.get::<_, Option<i64>>(2)?.map(|value| value as i32),
                        width: row.get::<_, Option<i64>>(3)?.map(|value| value as u32),
                        height: row.get::<_, Option<i64>>(4)?.map(|value| value as u32),
                        maximized: row.get::<_, i64>(5)? != 0,
                        monitor: row.get(6)?,
                        collapsed_groups: Vec::new(),
                        last_focused_at: Utc::now(),
                        updated_at: Utc::now(),
                    },
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(storage_error)?;
        let mut windows = Vec::new();
        for row in rows {
            let (mut window, collapsed, focused, updated) = row.map_err(storage_error)?;
            window.collapsed_groups = parse_collapsed_groups(&collapsed);
            window.last_focused_at = parse_time(&focused)?;
            window.updated_at = parse_time(&updated)?;
            windows.push(window);
        }
        Ok(windows)
    }

    /// Forgets one window. Its tabs stay, unwindowed, and reopen in the pane.
    pub fn remove_browser_window(&self, id: &str) -> Result<()> {
        let connection = self.connection.lock();
        connection
            .execute("DELETE FROM browser_windows WHERE id = ?1", [id])
            .map_err(storage_error)?;
        Ok(())
    }

    /// Records tabs that left the strip, then trims the table back to its cap
    /// so the oldest entries fall off the end.
    pub fn push_recent_tabs(&self, tabs: &[StoredRecentTab]) -> Result<()> {
        if tabs.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        for tab in tabs {
            insert_recent_tab(&transaction, tab)?;
        }
        trim_recent_tabs(&transaction)?;
        transaction.commit().map_err(storage_error)?;
        Ok(())
    }

    /// The tabs a group most recently lost, newest first.
    pub fn recent_tabs(&self, group_id: &str, limit: usize) -> Result<Vec<StoredRecentTab>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT task_id, group_id, url, title, favicon, closed_at, reason \
                 FROM browser_recent_tabs WHERE group_id = ?1 \
                 ORDER BY closed_at DESC, id DESC LIMIT ?2",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(params![group_id, limit as i64], recent_tab_row)
            .map_err(storage_error)?;
        let mut tabs = Vec::new();
        for row in rows {
            tabs.push(recent_tab_from_row(row.map_err(storage_error)?)?);
        }
        Ok(tabs)
    }

    /// Clears one group's recently closed tabs, or every group's.
    pub fn clear_recent_tabs(&self, group_id: Option<&str>) -> Result<()> {
        let connection = self.connection.lock();
        match group_id {
            Some(group) => connection
                .execute(
                    "DELETE FROM browser_recent_tabs WHERE group_id = ?1",
                    [group],
                )
                .map_err(storage_error)?,
            None => connection
                .execute("DELETE FROM browser_recent_tabs", [])
                .map_err(storage_error)?,
        };
        Ok(())
    }

    /// Drops the recently closed tabs of projects that are no longer trusted.
    /// Only `project:` groups are purged: a `chat` or `path:` group is not
    /// owned by a project and must survive one being removed.
    pub fn purge_recent_tabs_for_groups_not_in(&self, keep: &[String]) -> Result<()> {
        let connection = self.connection.lock();
        let mut sql =
            String::from("DELETE FROM browser_recent_tabs WHERE group_id LIKE 'project:%'");
        if !keep.is_empty() {
            sql.push_str(" AND group_id NOT IN (");
            for index in 0..keep.len() {
                if index > 0 {
                    sql.push(',');
                }
                sql.push('?');
            }
            sql.push(')');
        }
        let parameters: Vec<&dyn rusqlite::ToSql> = keep
            .iter()
            .map(|group| group as &dyn rusqlite::ToSql)
            .collect();
        connection
            .execute(&sql, parameters.as_slice())
            .map_err(storage_error)?;
        Ok(())
    }

    /// Retires popped-out tabs in one pass: first the ones nobody has touched
    /// since `before`, then whatever is left over `max_popped`, oldest touch
    /// first. Retired rows leave `browser_tabs` and arrive in the recently
    /// closed list, which is returned so the caller can close the live tabs
    /// that went with them. `group_of` supplies the group id a task belongs
    /// to, which `browser_tabs` does not store.
    pub fn retire_stale_browser_tabs(
        &self,
        before: DateTime<Utc>,
        max_popped: usize,
        now: DateTime<Utc>,
        group_of: &dyn Fn(TaskId) -> String,
    ) -> Result<Vec<StoredRecentTab>> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction().map_err(storage_error)?;
        let popped = {
            let mut statement = transaction
                .prepare(
                    "SELECT task_id, ordinal, url, title, favicon, last_touched_at \
                     FROM browser_tabs WHERE window_id IS NOT NULL",
                )
                .map_err(storage_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })
                .map_err(storage_error)?;
            let mut popped = Vec::new();
            for row in rows {
                let (task_id, ordinal, url, title, favicon, touched) =
                    row.map_err(storage_error)?;
                popped.push(PoppedRow {
                    task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
                    ordinal,
                    url,
                    title,
                    favicon,
                    last_touched_at: touched.as_deref().map(parse_time).transpose()?,
                });
            }
            popped
        };

        let (stale, mut remaining): (Vec<PoppedRow>, Vec<PoppedRow>) = popped
            .into_iter()
            .partition(|row| row.last_touched_at.is_some_and(|touched| touched < before));
        // Newest touch first, so the tabs cut by the cap are the ones the
        // person has gone longest without. A row with no touch at all sorts
        // last and is cut first.
        remaining.sort_by(|left, right| {
            right
                .last_touched_at
                .cmp(&left.last_touched_at)
                .then_with(|| left.task_id.to_string().cmp(&right.task_id.to_string()))
                .then_with(|| left.ordinal.cmp(&right.ordinal))
        });
        let over_cap = if remaining.len() > max_popped {
            remaining.split_off(max_popped)
        } else {
            Vec::new()
        };

        let mut retired = Vec::new();
        for (rows, reason) in [(stale, "stale"), (over_cap, "over-cap")] {
            for row in rows {
                transaction
                    .execute(
                        "DELETE FROM browser_tabs WHERE task_id = ?1 AND ordinal = ?2",
                        params![row.task_id.to_string(), row.ordinal],
                    )
                    .map_err(storage_error)?;
                let recent = StoredRecentTab {
                    group_id: group_of(row.task_id),
                    task_id: row.task_id,
                    url: row.url,
                    title: row.title,
                    favicon: row.favicon,
                    closed_at: now,
                    reason: reason.to_owned(),
                };
                insert_recent_tab(&transaction, &recent)?;
                retired.push(recent);
            }
        }
        if !retired.is_empty() {
            trim_recent_tabs(&transaction)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(retired)
    }
}

fn write_browser_window(
    connection: &rusqlite::Connection,
    window: &StoredBrowserWindow,
) -> Result<()> {
    let collapsed =
        serde_json::to_string(&window.collapsed_groups).unwrap_or_else(|_| String::from("[]"));
    connection
        .execute(
            "INSERT INTO browser_windows(\
               id, x, y, width, height, maximized, monitor, collapsed_groups, \
               last_focused_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(id) DO UPDATE SET \
               x = excluded.x, y = excluded.y, width = excluded.width, \
               height = excluded.height, maximized = excluded.maximized, \
               monitor = excluded.monitor, collapsed_groups = excluded.collapsed_groups, \
               last_focused_at = excluded.last_focused_at, updated_at = excluded.updated_at",
            params![
                window.id,
                window.x.map(i64::from),
                window.y.map(i64::from),
                window.width.map(i64::from),
                window.height.map(i64::from),
                i64::from(window.maximized),
                window.monitor,
                collapsed,
                window.last_focused_at.to_rfc3339(),
                window.updated_at.to_rfc3339(),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn insert_recent_tab(connection: &rusqlite::Connection, tab: &StoredRecentTab) -> Result<()> {
    connection
        .execute(
            "INSERT INTO browser_recent_tabs(\
               task_id, group_id, url, title, favicon, closed_at, reason) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                tab.task_id.to_string(),
                tab.group_id,
                tab.url,
                tab.title,
                tab.favicon,
                tab.closed_at.to_rfc3339(),
                tab.reason,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn trim_recent_tabs(connection: &rusqlite::Connection) -> Result<()> {
    connection
        .execute(
            "DELETE FROM browser_recent_tabs WHERE id NOT IN (\
               SELECT id FROM browser_recent_tabs ORDER BY closed_at DESC, id DESC LIMIT ?1)",
            [RECENT_TAB_CAP as i64],
        )
        .map_err(storage_error)?;
    Ok(())
}

/// A window's collapsed set is a json array of group ids. A row we cannot read
/// means "nothing collapsed" rather than a failed restore.
fn parse_collapsed_groups(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

type RecentTabRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
);

fn recent_tab_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecentTabRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

fn recent_tab_from_row(row: RecentTabRow) -> Result<StoredRecentTab> {
    let (task_id, group_id, url, title, favicon, closed_at, reason) = row;
    Ok(StoredRecentTab {
        task_id: TaskId::from_str(&task_id).map_err(invalid_stored)?,
        group_id,
        url,
        title,
        favicon,
        closed_at: parse_time(&closed_at)?,
        reason,
    })
}
