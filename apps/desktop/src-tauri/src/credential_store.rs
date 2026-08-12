use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

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

fn development_build() -> bool {
    cfg!(debug_assertions) || matches!(option_env!("TAURI_ENV_DEBUG"), Some("true"))
}

pub fn storage() -> CredentialStorage {
    if development_build() {
        CredentialStorage::ProtectedLocalFile
    } else {
        CredentialStorage::OsCredentialStore
    }
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
    let value = content.trim();
    Ok((!value.is_empty()).then(|| Zeroizing::new(value.to_owned())))
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
    let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(value.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn delete_development_at(data_directory: &Path, service: &str, account: &str) -> io::Result<()> {
    let path = development_path_at(data_directory, service, account);
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
                    Ok((!value.trim().is_empty()).then(|| Zeroizing::new(value.trim().to_owned())))
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
    Ok((!value.trim().is_empty()).then(|| Zeroizing::new(value.trim().to_owned())))
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
            Ok((!value.trim().is_empty()).then(|| Zeroizing::new(value.trim().to_owned())))
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
    if let Some(manifest) = manifest {
        delete_windows_generation(service, account, &manifest)?;
    }
    match manifest_entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err(CredentialStoreError),
    }
    let legacy = keyring::Entry::new(service, account).map_err(|_| CredentialStoreError)?;
    match legacy.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(CredentialStoreError),
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
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            read_development_at(&data_directory, service, account).map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => read_os_credential(service, account),
    }
}

pub fn write(service: &str, account: &str, value: &str) -> CredentialStoreResult<()> {
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            write_development_at(&data_directory, service, account, value)
                .map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => write_os_credential(service, account, value),
    }
}

pub fn delete(service: &str, account: &str) -> CredentialStoreResult<()> {
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            delete_development_at(&data_directory, service, account)
                .map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => delete_os_credential(service, account),
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
    fn debug_builds_never_select_the_os_credential_store() {
        assert_eq!(
            storage(),
            if development_build() {
                CredentialStorage::ProtectedLocalFile
            } else {
                CredentialStorage::OsCredentialStore
            }
        );
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
