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

pub fn read(service: &str, account: &str) -> CredentialStoreResult<Option<Zeroizing<String>>> {
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            read_development_at(&data_directory, service, account).map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => {
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
    }
}

pub fn write(service: &str, account: &str, value: &str) -> CredentialStoreResult<()> {
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            write_development_at(&data_directory, service, account, value)
                .map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => {
            let entry = keyring::Entry::new(service, account).map_err(|_| CredentialStoreError)?;
            entry.set_password(value).map_err(|_| CredentialStoreError)
        }
    }
}

pub fn delete(service: &str, account: &str) -> CredentialStoreResult<()> {
    match storage() {
        CredentialStorage::ProtectedLocalFile => {
            let data_directory = application_data_directory()?;
            delete_development_at(&data_directory, service, account)
                .map_err(|_| CredentialStoreError)
        }
        CredentialStorage::OsCredentialStore => {
            let entry = keyring::Entry::new(service, account).map_err(|_| CredentialStoreError)?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(CredentialStoreError),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
