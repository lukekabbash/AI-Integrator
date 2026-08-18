use std::{
    ffi::OsString,
    process::{Command, Stdio},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::command_api::{CommandError, CommandResult};

#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The environment a provider CLI is launched with.
///
/// This lives here rather than in `commands.rs` because it is not a command and
/// nothing about it is Tauri-shaped — it is one lookup against the runtime
/// search path. Modules that need it were reaching through the commands facade
/// to get at it, which the maintainability contract forbids for good reason:
/// that dependency is how a leaf module ends up transitively owning the whole
/// command surface.
pub(crate) fn runtime_launch_environment() -> Vec<(OsString, OsString)> {
    integrator_runtime::runtime_search_path()
        .map(path_launch_environment)
        .unwrap_or_default()
}

fn path_launch_environment(path: OsString) -> Vec<(OsString, OsString)> {
    vec![(OsString::from("PATH"), path)]
}

pub(crate) fn spawn_quiet(
    mut command: Command,
    failure_message: &'static str,
) -> CommandResult<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map(|_| ()).map_err(|error| CommandError {
        code: "external-open-failed",
        message: format!("{failure_message}: {error}"),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::ffi::OsStringExt;

    use super::*;

    #[test]
    fn runtime_path_environment_preserves_non_utf8_components() {
        let path = OsString::from_vec(vec![b'/', b't', b'm', b'p', b'/', 0xFF]);

        let environment = path_launch_environment(path.clone());

        assert_eq!(environment, vec![(OsString::from("PATH"), path)]);
    }
}
