use super::*;

impl LocalStore {
    pub fn set_setting(&self, key: &str, value: Value) -> Result<Setting> {
        validate_setting_key(key)?;
        let setting = Setting {
            key: key.to_owned(),
            value,
            updated_at: Utc::now(),
        };
        let value_json = serde_json::to_string(&setting.value)?;
        self.connection
            .lock()
            .execute(
                "INSERT INTO settings(key, value_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![setting.key, value_json, setting.updated_at.to_rfc3339()],
            )
            .map_err(storage_error)?;
        Ok(setting)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<Setting>> {
        validate_setting_key(key)?;
        let row = self
            .connection
            .lock()
            .query_row(
                "SELECT key, value_json, updated_at FROM settings WHERE key=?1",
                [key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        row.map(|(key, json, updated_at)| {
            Ok(Setting {
                key,
                value: serde_json::from_str(&json)?,
                updated_at: parse_time(&updated_at)?,
            })
        })
        .transpose()
    }

    pub fn list_settings(&self) -> Result<Vec<Setting>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT key, value_json, updated_at FROM settings ORDER BY key")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage_error)?;
        rows.map(|row| {
            let (key, json, updated_at) = row.map_err(storage_error)?;
            Ok(Setting {
                key,
                value: serde_json::from_str(&json)?,
                updated_at: parse_time(&updated_at)?,
            })
        })
        .collect()
    }
}

fn validate_setting_key(key: &str) -> Result<()> {
    let normalized = key.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 120
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(IntegratorError::InvalidInput("invalid setting key".into()));
    }
    if [
        "secret",
        "token",
        "password",
        "credential",
        "api_key",
        "apikey",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
    {
        return Err(IntegratorError::InvalidInput(
            "credentials cannot be stored as application settings".into(),
        ));
    }
    Ok(())
}
