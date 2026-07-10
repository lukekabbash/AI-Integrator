use thiserror::Error;

#[derive(Debug, Error)]
pub enum IntegratorError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("operation unavailable: {0}")]
    Unavailable(String),
    #[error("provider protocol error: {0}")]
    Protocol(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("git operation failed: {0}")]
    Git(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, IntegratorError>;
