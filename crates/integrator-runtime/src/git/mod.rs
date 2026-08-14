//! Narrow, repository-authorized Git operations for the native host.

use std::{
    path::{Path, PathBuf},
    str,
    time::Duration,
};

use crate::safe_process::{
    ProcessOutput, ProcessRunOutcome, redact_text, run_bounded_with_limits,
    run_bounded_with_outcome,
};
use integrator_core::{IntegratorError, Result};

mod authority;
mod history;
mod parse;
mod remote;
mod repository;
mod service;
mod types;
mod working_tree;

pub use authority::{AuthorizedRepositoryCache, authorize_repository};
use authority::{
    absolute_from, canonical_directory, validate_new_destination, validate_relative_path,
    validate_remote_name, validate_remote_url, validate_revision,
};
use parse::*;
use service::git_failure;
pub use types::*;

const MAX_GIT_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_COMMIT_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
pub struct GitService {
    executable: PathBuf,
}

#[derive(Default)]
struct PorcelainStatus {
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    files: Vec<FileStatus>,
}

#[cfg(test)]
mod tests;
