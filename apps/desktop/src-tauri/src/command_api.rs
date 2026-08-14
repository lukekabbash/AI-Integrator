use integrator_core::IntegratorError;
use serde::Serialize;

/// Stable error envelope for the narrow renderer-to-native command boundary.
pub(crate) type CommandResult<T> = std::result::Result<T, CommandError>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl From<IntegratorError> for CommandError {
    fn from(error: IntegratorError) -> Self {
        let code = match &error {
            IntegratorError::InvalidInput(_) => "invalid-input",
            IntegratorError::NotFound(_) => "not-found",
            IntegratorError::Unavailable(_) => "unavailable",
            IntegratorError::Unauthorized(_) => "unauthorized",
            IntegratorError::Protocol(_) => "provider-protocol",
            IntegratorError::Storage(_) => "storage",
            IntegratorError::Git(_) => "git",
            IntegratorError::Io(_) => "io",
            IntegratorError::Serialization(_) => "serialization",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

/// Stable failure used when a bounded native worker exits before returning.
pub(crate) fn worker_error() -> CommandError {
    CommandError {
        code: "worker-failed",
        message: "local worker stopped unexpectedly".into(),
    }
}
