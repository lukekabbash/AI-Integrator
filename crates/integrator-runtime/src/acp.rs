use std::path::{Path, PathBuf};

use async_trait::async_trait;
use integrator_core::{IntegratorError, ProviderKind, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpLaunchSpec {
    pub provider: ProviderKind,
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub working_directory: PathBuf,
}

impl AcpLaunchSpec {
    pub fn validate(&self) -> Result<()> {
        if !self.executable.is_file() {
            return Err(IntegratorError::InvalidInput(
                "ACP executable must be an existing file".into(),
            ));
        }
        if !self.working_directory.is_dir() {
            return Err(IntegratorError::InvalidInput(
                "ACP working directory must be an existing directory".into(),
            ));
        }
        if self.arguments.len() > 64
            || self
                .arguments
                .iter()
                .any(|argument| argument.len() > 4096 || argument.contains('\0'))
        {
            return Err(IntegratorError::InvalidInput(
                "ACP argument list exceeds safety limits".into(),
            ));
        }
        let file_name = self
            .executable
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            file_name.as_str(),
            "cmd" | "powershell" | "pwsh" | "sh" | "bash" | "zsh"
        ) {
            return Err(IntegratorError::InvalidInput(
                "shell executables are not valid ACP adapters".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEvent {
    pub session_id: String,
    pub method: String,
    pub payload: Value,
}

#[async_trait]
pub trait AcpSession: Send + Sync {
    fn provider(&self) -> ProviderKind;
    fn working_directory(&self) -> &Path;
    async fn send_prompt(&self, prompt: &str) -> Result<()>;
    async fn cancel(&self) -> Result<()>;
    async fn shutdown(&self) -> Result<()>;
}

#[async_trait]
pub trait AcpAdapter: Send + Sync {
    fn provider(&self) -> ProviderKind;
    async fn start(&self, spec: AcpLaunchSpec) -> Result<Box<dyn AcpSession>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_spec_rejects_shells() {
        let shell = if cfg!(windows) {
            PathBuf::from("C:/Windows/System32/cmd.exe")
        } else {
            PathBuf::from("/bin/sh")
        };
        if !shell.exists() {
            return;
        }
        let spec = AcpLaunchSpec {
            provider: ProviderKind::CustomAcp,
            executable: shell,
            arguments: vec![],
            working_directory: std::env::temp_dir(),
        };
        assert!(spec.validate().is_err());
    }
}
