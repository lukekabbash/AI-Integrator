use super::*;

impl LocalStore {
    /// Returns the persisted provider usage projections grouped by the runtime
    /// selected for each task. Missing provider usage remains a zero-valued
    /// projection so callers can label it as unavailable rather than infer it.
    pub fn provider_usage_rows(&self) -> Result<Vec<(String, u64, u64, UsageProjection)>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                r#"
                SELECT COALESCE(tasks.runtime, 'unknown'),
                       COUNT(DISTINCT integrator_turns.turn_id),
                       integrator_task_projection.usage_json
                FROM tasks
                LEFT JOIN integrator_turns ON integrator_turns.task_id = tasks.id
                LEFT JOIN integrator_task_projection ON integrator_task_projection.task_id = tasks.id
                GROUP BY tasks.id, tasks.runtime, integrator_task_projection.usage_json
                "#,
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                let provider = row.get::<_, String>(0)?;
                let turn_count = row.get::<_, u64>(1)?;
                let usage_json = row.get::<_, Option<String>>(2)?;
                let usage = usage_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<UsageProjection>(value).ok())
                    .unwrap_or_default();
                Ok((provider, turn_count, usage))
            })
            .map_err(storage_error)?;
        let mut grouped: BTreeMap<String, (u64, u64, UsageProjection)> = BTreeMap::new();
        for row in rows {
            let (provider, turn_count, usage) = row.map_err(storage_error)?;
            let entry = grouped
                .entry(provider)
                .or_insert_with(|| (0, 0, UsageProjection::default()));
            entry.0 += 1;
            entry.1 += turn_count;
            entry.2.input_tokens += usage.input_tokens;
            entry.2.cached_input_tokens += usage.cached_input_tokens;
            entry.2.output_tokens += usage.output_tokens;
            entry.2.reasoning_output_tokens += usage.reasoning_output_tokens;
            entry.2.total_tokens += usage.total_tokens;
            entry.2.model_context_window =
                match (entry.2.model_context_window, usage.model_context_window) {
                    (Some(current), Some(next)) => Some(current.max(next)),
                    (current, next) => current.or(next),
                };
            entry.2.vendor_cost_micro_usd =
                match (entry.2.vendor_cost_micro_usd, usage.vendor_cost_micro_usd) {
                    (None, None) => None,
                    (current, next) => Some(current.unwrap_or(0).saturating_add(next.unwrap_or(0))),
                };
        }
        Ok(grouped
            .into_iter()
            .map(|(provider, (task_count, turn_count, usage))| {
                (provider, task_count, turn_count, usage)
            })
            .collect())
    }

    /// Verified skill invocations are persisted on the provider-backed user
    /// item itself. Distinct stable ids keep retries, snapshot updates, and
    /// copied fork history from inflating the count.
    pub fn skill_invocation_counts(&self) -> Result<BTreeMap<String, u64>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT native_skill, COUNT(DISTINCT stable_id) FROM integrator_items \
                 WHERE native_skill IS NOT NULL GROUP BY native_skill",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })
            .map_err(storage_error)?;
        let mut counts = BTreeMap::new();
        for row in rows {
            let (skill, count) = row.map_err(storage_error)?;
            counts.insert(skill, count);
        }
        Ok(counts)
    }
}
