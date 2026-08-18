//! One-time re-keying of saved logins from the legacy per-task jars
//! (`task:<uuid>`, `task:opaque-<hex>`) to the jar of the task's group.
//!
//! A secret is filed under `"{bucket} {origin} {username}"`, so moving a login
//! between buckets means writing it under the new account before the manifest
//! points there and deleting the old account only after the manifest is
//! durable. Each entry is moved on its own: a failure leaves that entry and
//! every later one exactly as they were, and the next start retries them.

use zeroize::Zeroizing;

use crate::command_api::CommandError;
use session_store::LocalStore;

use super::{
    BrowserIdentityScope,
    identity::{self, is_legacy_task_bucket},
    unavailable,
    vault::{self, SavedLogin},
};

/// What the migration did. Zero everywhere means there was nothing legacy left.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskBucketMigration {
    /// Entries re-keyed to a group bucket that had no login for that account.
    pub moved: usize,
    /// Entries that met an existing group login; the newer of the two stayed.
    pub merged: usize,
}

/// The three operations the migration needs from the credential store. Real
/// runs go to the OS store; tests use an in-memory map that can be told to
/// fail on one account.
pub(super) trait SecretStore {
    fn read(&mut self, account: &str) -> Result<Option<Zeroizing<String>>, ()>;
    fn write(&mut self, account: &str, value: &str) -> Result<(), ()>;
    fn delete(&mut self, account: &str) -> Result<(), ()>;
}

struct OsSecretStore;

impl SecretStore for OsSecretStore {
    fn read(&mut self, account: &str) -> Result<Option<Zeroizing<String>>, ()> {
        crate::credential_store::read(vault::SERVICE, account).map_err(|_| ())
    }

    fn write(&mut self, account: &str, value: &str) -> Result<(), ()> {
        crate::credential_store::write(vault::SERVICE, account, value).map_err(|_| ())
    }

    fn delete(&mut self, account: &str) -> Result<(), ()> {
        crate::credential_store::delete(vault::SERVICE, account).map_err(|_| ())
    }
}

/// Where a legacy per-task login belongs now. `task:<uuid>` resolves through
/// the task's group; `task:opaque-<hex>` was a digest of an unparsable task id,
/// which is exactly the digest its `path:` group uses, so it maps directly.
fn group_bucket_for_legacy(store: &LocalStore, legacy_bucket: &str) -> Option<String> {
    let suffix = legacy_bucket.strip_prefix("task:")?;
    if let Some(digest) = suffix.strip_prefix("opaque-") {
        let candidate = format!("path:{digest}");
        return identity::profile_segment(&candidate).map(|_| candidate);
    }
    Some(identity::bucket_for_task_in_store(
        store,
        BrowserIdentityScope::Task,
        suffix,
    ))
}

/// Puts one account back the way it was before a write.
fn restore(
    secrets: &mut dyn SecretStore,
    account: &str,
    previous: Option<Zeroizing<String>>,
) -> bool {
    match previous {
        Some(value) => secrets.write(account, &value).is_ok(),
        None => secrets.delete(account).is_ok(),
    }
}

/// Copies the secret under `from` to `to`, then commits `entries` as the
/// manifest, then removes `from`. Any failure before the manifest is durable
/// undoes the copy; a failure removing the old secret leaves an orphaned
/// account, which is harmless (nothing lists it) and is retried on demand.
fn move_secret_and_commit(
    store: &LocalStore,
    secrets: &mut dyn SecretStore,
    from: &str,
    to: &str,
    entries: &[SavedLogin],
) -> Result<(), CommandError> {
    let secret = secrets
        .read(from)
        .map_err(|()| unavailable("a legacy browser credential could not be read"))?;
    let previous = match &secret {
        Some(_) => Some(
            secrets
                .read(to)
                .map_err(|()| unavailable("a browser credential target could not be read"))?,
        ),
        None => None,
    };
    if let Some(secret) = &secret
        && secrets.write(to, secret).is_err()
    {
        let restored = restore(secrets, to, previous.flatten());
        return Err(unavailable(if restored {
            "a browser credential could not be moved to its group"
        } else {
            "a browser credential move and its rollback did not finish"
        }));
    }
    if let Err(error) = vault::write_manifest_at(store, entries) {
        if secret.is_some() && !restore(secrets, to, previous.flatten()) {
            return Err(unavailable(
                "the saved-login manifest failed and its credential rollback did not finish",
            ));
        }
        return Err(error);
    }
    if secret.is_some() {
        let _ = secrets.delete(from);
    }
    Ok(())
}

fn same_account(left: &SavedLogin, bucket: &str, origin: &str, username: &str) -> bool {
    left.bucket_id == bucket && left.origin == origin && left.username == username
}

pub(super) fn migrate_with(
    store: &LocalStore,
    secrets: &mut dyn SecretStore,
) -> Result<TaskBucketMigration, CommandError> {
    let mut entries = vault::manifest_at(store);
    let mut report = TaskBucketMigration::default();
    loop {
        let Some(index) = entries
            .iter()
            .position(|entry| is_legacy_task_bucket(&entry.bucket_id))
        else {
            return Ok(report);
        };
        let legacy = entries[index].clone();
        let Some(target) = group_bucket_for_legacy(store, &legacy.bucket_id) else {
            // Not a form we can place; the manifest filter would have dropped
            // it already, but be explicit rather than loop forever.
            entries.remove(index);
            vault::write_manifest_at(store, &entries)?;
            continue;
        };
        let old_account = vault::account_key(&legacy.bucket_id, &legacy.origin, &legacy.username);
        let new_account = vault::account_key(&target, &legacy.origin, &legacy.username);
        let existing = entries
            .iter()
            .position(|entry| same_account(entry, &target, &legacy.origin, &legacy.username));

        match existing {
            None => {
                let mut next = entries.clone();
                next[index].bucket_id = target;
                move_secret_and_commit(store, secrets, &old_account, &new_account, &next)?;
                entries = next;
                report.moved += 1;
            }
            Some(existing_index)
                if vault::login_recency(&entries[existing_index])
                    >= vault::login_recency(&legacy) =>
            {
                // The group already has the newer login: drop the legacy one.
                secrets.delete(&old_account).map_err(|()| {
                    unavailable("a legacy browser credential could not be removed")
                })?;
                entries.remove(index);
                vault::write_manifest_at(store, &entries)?;
                report.merged += 1;
            }
            Some(existing_index) => {
                // The legacy login is newer: it replaces the group's secret and
                // its row takes over the group's slot.
                let mut next = entries.clone();
                let mut winner = legacy.clone();
                winner.bucket_id = target;
                next[existing_index] = winner;
                next.remove(index);
                move_secret_and_commit(store, secrets, &old_account, &new_account, &next)?;
                entries = next;
                report.merged += 1;
            }
        }
    }
}

/// Runs once per start, after the profile layout is prepared. Idempotent: with
/// no legacy entries left it reads the manifest and returns.
pub fn migrate_task_buckets_to_groups(
    store: &LocalStore,
) -> Result<TaskBucketMigration, CommandError> {
    let _mutation = vault::lock_mutations();
    migrate_with(store, &mut OsSecretStore)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use integrator_core::{NewTask, TaskKind};
    use serde_json::json;

    use super::*;
    use crate::browser::groups;

    #[derive(Default)]
    struct MemorySecrets {
        values: HashMap<String, String>,
        fail_write_on: Option<String>,
    }

    impl SecretStore for MemorySecrets {
        fn read(&mut self, account: &str) -> Result<Option<Zeroizing<String>>, ()> {
            Ok(self
                .values
                .get(account)
                .map(|value| Zeroizing::new(value.clone())))
        }

        fn write(&mut self, account: &str, value: &str) -> Result<(), ()> {
            if self.fail_write_on.as_deref() == Some(account) {
                return Err(());
            }
            self.values.insert(account.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&mut self, account: &str) -> Result<(), ()> {
            self.values.remove(account);
            Ok(())
        }
    }

    const ORIGIN: &str = "https://example.com";

    fn login(bucket: &str, user: &str, saved_at: &str) -> serde_json::Value {
        json!({
            "bucketId": bucket,
            "origin": ORIGIN,
            "username": user,
            "savedAt": saved_at,
        })
    }

    struct Fixture {
        store: LocalStore,
        task: String,
        project_bucket: String,
        _directory: tempfile::TempDir,
    }

    fn new_fixture() -> Fixture {
        let directory = tempfile::tempdir().expect("temp directory");
        let repository = directory.path().join("repository");
        std::fs::create_dir_all(&repository).expect("fixture");
        let store = LocalStore::open_in_memory().expect("open store");
        let project = store
            .upsert_trusted_project("My project", &repository, None)
            .expect("register project");
        let task = store
            .create_task(NewTask {
                kind: TaskKind::Code,
                title: "t".into(),
                repository_path: Some(repository),
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task")
            .id
            .to_string();
        Fixture {
            store,
            task,
            project_bucket: groups::project_group_id(project.id),
            _directory: directory,
        }
    }

    fn manifest(store: &LocalStore) -> Vec<SavedLogin> {
        vault::manifest_at(store)
    }

    #[test]
    fn a_task_jar_login_moves_to_its_group_and_is_idempotent() {
        let fixture = new_fixture();
        let legacy_bucket = format!("task:{}", fixture.task);
        fixture
            .store
            .set_setting(
                vault::SAVED_LOGINS_SETTING,
                json!([login(&legacy_bucket, "ana", "2026-08-17T00:00:00Z")]),
            )
            .unwrap();
        let mut secrets = MemorySecrets::default();
        let old_account = vault::account_key(&legacy_bucket, ORIGIN, "ana");
        secrets.values.insert(old_account.clone(), "pw".into());

        let report = migrate_with(&fixture.store, &mut secrets).unwrap();
        assert_eq!(
            report,
            TaskBucketMigration {
                moved: 1,
                merged: 0
            }
        );

        let entries = manifest(&fixture.store);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].bucket_id, fixture.project_bucket);
        let new_account = vault::account_key(&fixture.project_bucket, ORIGIN, "ana");
        assert_eq!(
            secrets.values.get(&new_account).map(String::as_str),
            Some("pw")
        );
        assert!(!secrets.values.contains_key(&old_account));

        // A second run finds nothing to do and touches nothing.
        let again = migrate_with(&fixture.store, &mut secrets).unwrap();
        assert_eq!(again, TaskBucketMigration::default());
        assert_eq!(manifest(&fixture.store), entries);
    }

    #[test]
    fn an_opaque_task_jar_maps_to_the_matching_path_group() {
        let fixture = new_fixture();
        let legacy_bucket = identity::legacy_opaque_task_bucket_id("not-a-task");
        let expected = groups::resolve_group(&fixture.store, "not-a-task").id;
        fixture
            .store
            .set_setting(
                vault::SAVED_LOGINS_SETTING,
                json!([login(&legacy_bucket, "ana", "2026-08-17T00:00:00Z")]),
            )
            .unwrap();
        let mut secrets = MemorySecrets::default();
        secrets.values.insert(
            vault::account_key(&legacy_bucket, ORIGIN, "ana"),
            "pw".into(),
        );

        migrate_with(&fixture.store, &mut secrets).unwrap();

        let entries = manifest(&fixture.store);
        assert_eq!(entries[0].bucket_id, expected);
        assert!(expected.starts_with("path:"));
        assert!(
            secrets
                .values
                .contains_key(&vault::account_key(&expected, ORIGIN, "ana"))
        );
    }

    #[test]
    fn a_collision_keeps_the_newer_login_either_way() {
        // Newer already in the group: legacy is dropped, group secret untouched.
        let fixture = new_fixture();
        let legacy_bucket = format!("task:{}", fixture.task);
        fixture
            .store
            .set_setting(
                vault::SAVED_LOGINS_SETTING,
                json!([
                    login(&legacy_bucket, "ana", "2026-08-16T00:00:00Z"),
                    login(&fixture.project_bucket, "ana", "2026-08-17T00:00:00Z"),
                ]),
            )
            .unwrap();
        let mut secrets = MemorySecrets::default();
        let old_account = vault::account_key(&legacy_bucket, ORIGIN, "ana");
        let new_account = vault::account_key(&fixture.project_bucket, ORIGIN, "ana");
        secrets.values.insert(old_account.clone(), "old-pw".into());
        secrets
            .values
            .insert(new_account.clone(), "group-pw".into());

        let report = migrate_with(&fixture.store, &mut secrets).unwrap();
        assert_eq!(
            report,
            TaskBucketMigration {
                moved: 0,
                merged: 1
            }
        );
        let entries = manifest(&fixture.store);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].bucket_id, fixture.project_bucket);
        assert_eq!(entries[0].saved_at, "2026-08-17T00:00:00Z");
        assert_eq!(
            secrets.values.get(&new_account).map(String::as_str),
            Some("group-pw")
        );
        assert!(!secrets.values.contains_key(&old_account));

        // Newer in the legacy jar: it replaces the group's secret and row.
        let fixture = new_fixture();
        let legacy_bucket = format!("task:{}", fixture.task);
        fixture
            .store
            .set_setting(
                vault::SAVED_LOGINS_SETTING,
                json!([
                    login(&fixture.project_bucket, "ana", "2026-08-16T00:00:00Z"),
                    login(&legacy_bucket, "ana", "2026-08-17T00:00:00Z"),
                ]),
            )
            .unwrap();
        let mut secrets = MemorySecrets::default();
        let old_account = vault::account_key(&legacy_bucket, ORIGIN, "ana");
        let new_account = vault::account_key(&fixture.project_bucket, ORIGIN, "ana");
        secrets
            .values
            .insert(old_account.clone(), "newer-pw".into());
        secrets
            .values
            .insert(new_account.clone(), "group-pw".into());

        let report = migrate_with(&fixture.store, &mut secrets).unwrap();
        assert_eq!(
            report,
            TaskBucketMigration {
                moved: 0,
                merged: 1
            }
        );
        let entries = manifest(&fixture.store);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].bucket_id, fixture.project_bucket);
        assert_eq!(entries[0].saved_at, "2026-08-17T00:00:00Z");
        assert_eq!(
            secrets.values.get(&new_account).map(String::as_str),
            Some("newer-pw")
        );
        assert!(!secrets.values.contains_key(&old_account));
    }

    #[test]
    fn a_failure_mid_way_leaves_the_unmoved_entries_intact() {
        let fixture = new_fixture();
        let legacy_bucket = format!("task:{}", fixture.task);
        fixture
            .store
            .set_setting(
                vault::SAVED_LOGINS_SETTING,
                json!([
                    login(&legacy_bucket, "ana", "2026-08-17T00:00:00Z"),
                    login(&legacy_bucket, "bo", "2026-08-17T00:00:00Z"),
                ]),
            )
            .unwrap();
        let mut secrets = MemorySecrets::default();
        let ana_old = vault::account_key(&legacy_bucket, ORIGIN, "ana");
        let bo_old = vault::account_key(&legacy_bucket, ORIGIN, "bo");
        let ana_new = vault::account_key(&fixture.project_bucket, ORIGIN, "ana");
        let bo_new = vault::account_key(&fixture.project_bucket, ORIGIN, "bo");
        secrets.values.insert(ana_old.clone(), "ana-pw".into());
        secrets.values.insert(bo_old.clone(), "bo-pw".into());
        secrets.fail_write_on = Some(bo_new.clone());

        assert!(migrate_with(&fixture.store, &mut secrets).is_err());

        // ana moved and committed; bo is exactly as it was, ready for a retry.
        let entries = manifest(&fixture.store);
        assert_eq!(entries.len(), 2);
        assert!(
            entries
                .iter()
                .any(|entry| entry.username == "ana" && entry.bucket_id == fixture.project_bucket)
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.username == "bo" && entry.bucket_id == legacy_bucket)
        );
        assert_eq!(
            secrets.values.get(&ana_new).map(String::as_str),
            Some("ana-pw")
        );
        assert!(!secrets.values.contains_key(&ana_old));
        assert_eq!(
            secrets.values.get(&bo_old).map(String::as_str),
            Some("bo-pw")
        );
        assert!(!secrets.values.contains_key(&bo_new));

        // Once the store cooperates, the retry finishes the job.
        secrets.fail_write_on = None;
        let report = migrate_with(&fixture.store, &mut secrets).unwrap();
        assert_eq!(
            report,
            TaskBucketMigration {
                moved: 1,
                merged: 0
            }
        );
        assert!(
            manifest(&fixture.store)
                .iter()
                .all(|entry| entry.bucket_id == fixture.project_bucket)
        );
        assert_eq!(
            secrets.values.get(&bo_new).map(String::as_str),
            Some("bo-pw")
        );
    }
}
