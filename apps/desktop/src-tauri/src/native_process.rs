use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::command_api::{CommandError, CommandResult};

#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
