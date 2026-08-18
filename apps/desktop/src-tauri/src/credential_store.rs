use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use directories::ProjectDirs;
use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const DEVELOPMENT_CREDENTIAL_DIRECTORY: &str = "developer-credentials";
#[cfg(target_os = "windows")]
const WINDOWS_CREDENTIAL_CHUNK_BYTES: usize = 2_400;
#[cfg(target_os = "windows")]
const WINDOWS_CREDENTIAL_MAX_CHUNKS: usize = 32;
#[cfg(target_os = "windows")]
const WINDOWS_CREDENTIAL_MANIFEST_VERSION: &str = "v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStorage {
    ProtectedLocalFile,
    OsCredentialStore,
}

#[derive(Clone, Copy, Debug)]
pub struct CredentialStoreError;

pub type CredentialStoreResult<T> = std::result::Result<T, CredentialStoreError>;

pub fn storage() -> CredentialStorage {
    // Unit tests use a bounded local fixture. Every real app build, including
    // `tauri dev`, uses the OS-owned credential store.
    if cfg!(test) {
        CredentialStorage::ProtectedLocalFile
    } else {
        CredentialStorage::OsCredentialStore
    }
}

fn operation_lock(service: &str, account: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = format!("{service}\0{account}");
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn application_data_directory() -> CredentialStoreResult<PathBuf> {
    ProjectDirs::from("dev", "AI Integrator", "AI Integrator")
        .map(|directories| directories.data_local_dir().to_path_buf())
        .ok_or(CredentialStoreError)
}

fn development_directory_at(data_directory: &Path) -> PathBuf {
    data_directory.join(DEVELOPMENT_CREDENTIAL_DIRECTORY)
}

fn credential_file_name(service: &str, account: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(service.as_bytes());
    digest.update([0]);
    digest.update(account.as_bytes());
    format!("{:x}", digest.finalize())
}

fn development_path_at(data_directory: &Path, service: &str, account: &str) -> PathBuf {
    development_directory_at(data_directory).join(credential_file_name(service, account))
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "developer credential path is not a directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir_all(path)?,
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn read_development_at(
    data_directory: &Path,
    service: &str,
    account: &str,
) -> io::Result<Option<Zeroizing<String>>> {
    let directory = development_directory_at(data_directory);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "developer credential path is not a directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;

    let path = development_path_at(data_directory, service, account);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "developer credential is not a regular file",
        ));
    }
    #[cfg(unix)]
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let content = Zeroizing::new(fs::read_to_string(path)?);
    Ok((!content.is_empty()).then_some(content))
}

fn write_development_at(
    data_directory: &Path,
    service: &str,
    account: &str,
    value: &str,
) -> io::Result<()> {
    let directory = development_directory_at(data_directory);
    ensure_private_directory(&directory)?;
    let path = development_path_at(data_directory, service, account);
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "developer credential is not a regular file",
        ));
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".integrator-credential-")
        .tempfile_in(&directory)?;
    #[cfg(unix)]
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    temporary.write_all(value.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error)
}

fn delete_development_at(data_directory: &Path, service: &str, account: &str) -> io::Result<()> {
    let directory = development_directory_at(data_directory);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "developer credential path is not a directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let path = development_path_at(data_directory, service, account);
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "developer credential is not a regular file",
        ));
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn available(service: &str, account: &str) -> bool {
    match storage() {
        CredentialStorage::ProtectedLocalFile => application_data_directory().is_ok(),
        CredentialStorage::OsCredentialStore => keyring::Entry::new(service, account).is_ok(),
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowsCredentialManifest {
    generation: String,
    chunks: usize,
    length: usize,
    digest: String,
}

#[cfg(target_os = "windows")]
fn windows_manifest_account(account: &str) -> String {
    format!("{account}::manifest")
}

#[cfg(target_os = "windows")]
fn windows_chunk_account(account: &str, generation: &str, index: usize) -> String {
    format!("{account}::chunk::{generation}::{index}")
}

#[cfg(target_os = "windows")]
fn parse_windows_manifest(value: &str) -> Option<WindowsCredentialManifest> {
    let mut fields = value.split(':');
    let version = fields.next()?;
    let generation = fields.next()?.to_owned();
    let chunks = fields.next()?.parse::<usize>().ok()?;
    let length = fields.next()?.parse::<usize>().ok()?;
    let digest = fields.next()?.to_owned();
    if fields.next().is_some()
        || version != WINDOWS_CREDENTIAL_MANIFEST_VERSION
        || generation.len() != 36
        || !generation
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        || !(1..=WINDOWS_CREDENTIAL_MAX_CHUNKS).contains(&chunks)
        || length > WINDOWS_CREDENTIAL_CHUNK_BYTES * WINDOWS_CREDENTIAL_MAX_CHUNKS
        || digest.len() != 64
        || !digest
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return None;
    }
    Some(WindowsCredentialManifest {
        generation,
        chunks,
        length,
        digest,
    })
}

#[cfg(target_os = "windows")]
fn windows_manifest(value: &[u8], generation: String) -> WindowsCredentialManifest {
    WindowsCredentialManifest {
        generation,
        chunks: value.len().div_ceil(WINDOWS_CREDENTIAL_CHUNK_BYTES).max(1),
        length: value.len(),
        digest: format!("{:x}", Sha256::digest(value)),
    }
}

#[cfg(target_os = "windows")]
fn encode_windows_manifest(manifest: &WindowsCredentialManifest) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        WINDOWS_CREDENTIAL_MANIFEST_VERSION,
        manifest.generation,
        manifest.chunks,
        manifest.length,
        manifest.digest
    )
}

#[cfg(target_os = "windows")]
fn delete_windows_generation(
    service: &str,
    account: &str,
    manifest: &WindowsCredentialManifest,
) -> CredentialStoreResult<()> {
    for index in 0..manifest.chunks {
        let entry = keyring::Entry::new(
            service,
            &windows_chunk_account(account, &manifest.generation, index),
        )
        .map_err(|_| CredentialStoreError)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err(CredentialStoreError),
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn read_os_credential(
    service: &str,
    account: &str,
) -> CredentialStoreResult<Option<Zeroizing<String>>> {
    let manifest_entry = keyring::Entry::new(service, &windows_manifest_account(account))
        .map_err(|_| CredentialStoreError)?;
    let manifest = match manifest_entry.get_password() {
        Ok(value) => parse_windows_manifest(&value).ok_or(CredentialStoreError)?,
        Err(keyring::Error::NoEntry) => {
            let legacy = keyring::Entry::new(service, account).map_err(|_| CredentialStoreError)?;
            return match legacy.get_password() {
                Ok(value) => {
                    let value = Zeroizing::new(value);
                    Ok((!value.is_empty()).then_some(value))
                }
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(CredentialStoreError),
            };
        }
        Err(_) => return Err(CredentialStoreError),
    };

    let mut bytes = Zeroizing::new(Vec::with_capacity(manifest.length));
    for index in 0..manifest.chunks {
        let entry = keyring::Entry::new(
            service,
            &windows_chunk_account(account, &manifest.generation, index),
        )
        .map_err(|_| CredentialStoreError)?;
        let chunk = Zeroizing::new(entry.get_secret().map_err(|_| CredentialStoreError)?);
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != manifest.length
        || format!("{:x}", Sha256::digest(bytes.as_slice())) != manifest.digest
    {
        return Err(CredentialStoreError);
    }
    let value = std::str::from_utf8(&bytes).map_err(|_| CredentialStoreError)?;
    Ok((!value.is_empty()).then(|| Zeroizing::new(value.to_owned())))
}

#[cfg(not(target_os = "windows"))]
fn read_os_credential(
    service: &str,
    account: &str,
) -> CredentialStoreResult<Option<Zeroizing<String>>> {
    let entry = keyring::Entry::new(service, account).map_err(|_| CredentialStoreError)?;
    match entry.get_password() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            Ok((!value.is_empty()).then_some(value))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(CredentialStoreError),
    }
}

#[cfg(target_os = "windows")]
fn write_os_credential(service: &str, account: &str, value: &str) -> CredentialStoreResult<()> {
    let value = Zeroizing::new(value.as_bytes().to_vec());
    if value.len() > WINDOWS_CREDENTIAL_CHUNK_BYTES * WINDOWS_CREDENTIAL_MAX_CHUNKS {
        return Err(CredentialStoreError);
    }
    let manifest_entry = keyring::Entry::new(service, &windows_manifest_account(account))
        .map_err(|_| CredentialStoreError)?;
    let previous_manifest = manifest_entry
        .get_password()
        .ok()
        .and_then(|value| parse_windows_manifest(&value));
    let manifest = windows_manifest(&value, uuid::Uuid::new_v4().to_string());

    for index in 0..manifest.chunks {
        let start = index * WINDOWS_CREDENTIAL_CHUNK_BYTES;
        let end = (start + WINDOWS_CREDENTIAL_CHUNK_BYTES).min(value.len());
        let entry = keyring::Entry::new(
            service,
            &windows_chunk_account(account, &manifest.generation, index),
        )
        .map_err(|_| CredentialStoreError)?;
        if entry.set_secret(&value[start..end]).is_err() {
            let _ = delete_windows_generation(service, account, &manifest);
            return Err(CredentialStoreError);
        }
    }
    if manifest_entry
        .set_password(&encode_windows_manifest(&manifest))
        .is_err()
    {
        let _ = delete_windows_generation(service, account, &manifest);
        return Err(CredentialStoreError);
    }

    if let Ok(legacy) = keyring::Entry::new(service, account) {
        let _ = legacy.delete_credential();
    }
    if let Some(previous_manifest) = previous_manifest
        && previous_manifest.generation != manifest.generation
    {
        let _ = delete_windows_generation(service, account, &previous_manifest);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn write_os_credential(service: &str, account: &str, value: &str) -> CredentialStoreResult<()> {
    let entry = keyring::Entry::new(service, account).map_err(|_| CredentialStoreError)?;
    entry.set_password(value).map_err(|_| CredentialStoreError)
}

#[cfg(target_os = "windows")]
fn delete_os_credential(service: &str, account: &str) -> CredentialStoreResult<()> {
    let manifest_entry = keyring::Entry::new(service, &windows_manifest_account(account))
        .map_err(|_| CredentialStoreError)?;
    let manifest = match manifest_entry.get_password() {
        Ok(value) => Some(parse_windows_manifest(&value).ok_or(CredentialStoreError)?),
        Err(keyring::Error::NoEntry) => None,
        Err(_) => return Err(CredentialStoreError),
    };
    // Remove the manifest first. A partial chunk cleanup may leave an orphan,
    // but never a live manifest that points at a half-deleted credential.
    match manifest_entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err(CredentialStoreError),
    }
    let mut cleanup_failed = manifest
        .as_ref()
        .is_some_and(|manifest| delete_windows_generation(service, account, manifest).is_err());
    let legacy = keyring::Entry::new(service, account).map_err(|_| CredentialStoreError)?;
    match legacy.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => cleanup_failed = true,
    }
    if cleanup_failed {
        Err(CredentialStoreError)
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn delete_os_credential(service: &str, account: &str) -> CredentialStoreResult<()> {
    let entry = keyring::Entry::new(service, account).map_err(|_| CredentialStoreError)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(CredentialStoreError),
    }
}

pub fn read(service: &str, account: &str) -> CredentialStoreResult<Option<Zeroizing<String>>> {
    let lock = operation_lock(service, account);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            read_development_at(&data_directory, service, account).map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => {
            if let Some(value) = read_os_credential(service, account)? {
                return Ok(Some(value));
            }
            // Migrate the former debug-only file store lazily. The source is
            // removed only after the OS store has accepted the exact value.
            let data_directory = application_data_directory()?;
            let Some(value) = read_development_at(&data_directory, service, account)
                .map_err(|_| CredentialStoreError)?
            else {
                return Ok(None);
            };
            write_os_credential(service, account, &value)?;
            if delete_development_at(&data_directory, service, account).is_err() {
                let _ = delete_os_credential(service, account);
                return Err(CredentialStoreError);
            }
            Ok(Some(value))
        }
    }
}

pub fn write(service: &str, account: &str, value: &str) -> CredentialStoreResult<()> {
    let lock = operation_lock(service, account);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            write_development_at(&data_directory, service, account, value)
                .map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => {
            let previous = read_os_credential(service, account)?;
            write_os_credential(service, account, value)?;
            let data_directory = application_data_directory()?;
            if delete_development_at(&data_directory, service, account).is_err() {
                let _ = match previous {
                    Some(previous) => write_os_credential(service, account, &previous),
                    None => delete_os_credential(service, account),
                };
                return Err(CredentialStoreError);
            }
            Ok(())
        }
    }
}

pub fn delete(service: &str, account: &str) -> CredentialStoreResult<()> {
    let lock = operation_lock(service, account);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            delete_development_at(&data_directory, service, account)
                .map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => {
            let previous = read_os_credential(service, account)?;
            delete_os_credential(service, account)?;
            let data_directory = application_data_directory()?;
            if delete_development_at(&data_directory, service, account).is_err() {
                if let Some(previous) = previous {
                    let _ = write_os_credential(service, account, &previous);
                }
                return Err(CredentialStoreError);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    struct WindowsCredentialCleanup {
        service: String,
        account: String,
    }

    #[cfg(target_os = "windows")]
    impl Drop for WindowsCredentialCleanup {
        fn drop(&mut self) {
            let _ = delete_os_credential(&self.service, &self.account);
        }
    }

    #[test]
    fn tests_use_the_bounded_local_credential_fixture() {
        assert_eq!(storage(), CredentialStorage::ProtectedLocalFile);
    }

    #[test]
    fn development_credentials_are_private_and_namespaced() {
        let data_directory = tempfile::tempdir().expect("data directory");
        write_development_at(data_directory.path(), "service-a", "account", "secret")
            .expect("write secret");
        write_development_at(data_directory.path(), "service-b", "account", "other")
            .expect("write second secret");

        assert_eq!(
            read_development_at(data_directory.path(), "service-a", "account")
                .expect("read secret")
                .as_deref()
                .map(String::as_str),
            Some("secret")
        );
        assert_eq!(
            read_development_at(data_directory.path(), "service-b", "account")
                .expect("read second secret")
                .as_deref()
                .map(String::as_str),
            Some("other")
        );

        #[cfg(unix)]
        {
            let directory_mode = fs::metadata(development_directory_at(data_directory.path()))
                .expect("secret directory")
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(development_path_at(
                data_directory.path(),
                "service-a",
                "account",
            ))
            .expect("secret file")
            .permissions()
            .mode()
                & 0o777;
            assert_eq!(directory_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }

        delete_development_at(data_directory.path(), "service-a", "account")
            .expect("delete secret");
        assert!(
            read_development_at(data_directory.path(), "service-a", "account")
                .expect("read missing secret")
                .is_none()
        );
    }

    #[test]
    fn development_credentials_preserve_surrounding_whitespace() {
        let data_directory = tempfile::tempdir().expect("data directory");
        write_development_at(data_directory.path(), "service", "account", "  secret\n")
            .expect("write exact secret");

        assert_eq!(
            read_development_at(data_directory.path(), "service", "account")
                .expect("read exact secret")
                .as_deref()
                .map(String::as_str),
            Some("  secret\n")
        );
    }

    #[test]
    fn development_credential_replacement_is_atomic_and_refuses_non_files() {
        let data_directory = tempfile::tempdir().expect("data directory");
        write_development_at(data_directory.path(), "service", "account", "first")
            .expect("write first secret");
        write_development_at(data_directory.path(), "service", "account", "second")
            .expect("replace secret");
        assert_eq!(
            read_development_at(data_directory.path(), "service", "account")
                .expect("read replacement")
                .as_deref()
                .map(String::as_str),
            Some("second")
        );

        let blocked = development_path_at(data_directory.path(), "service", "blocked");
        fs::create_dir(&blocked).expect("non-file sentinel");
        assert!(
            write_development_at(data_directory.path(), "service", "blocked", "secret").is_err()
        );
        assert!(blocked.is_dir());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_os_store_round_trips_large_oauth_bundles() {
        let service = format!("dev.aiintegrator.test.{}", uuid::Uuid::new_v4());
        let account = "large-oauth-bundle".to_owned();
        let _cleanup = WindowsCredentialCleanup {
            service: service.clone(),
            account: account.clone(),
        };
        let value = format!(
            "{{\"access_token\":\"{}\",\"refresh_token\":\"{}\"}}",
            "a".repeat(3_000),
            "r".repeat(3_000)
        );

        write_os_credential(&service, &account, &value).expect("write chunked credential");
        assert_eq!(
            read_os_credential(&service, &account)
                .expect("read chunked credential")
                .as_deref()
                .map(String::as_str),
            Some(value.as_str())
        );
        delete_os_credential(&service, &account).expect("delete chunked credential");
        assert!(
            read_os_credential(&service, &account)
                .expect("read deleted credential")
                .is_none()
        );
    }
}
