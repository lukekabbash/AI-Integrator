use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use integrator_core::{IntegratorError, Result};

const MAX_PROBE_BYTES: u64 = 256 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct ProcessOutput {
    pub(crate) success: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
}

pub(crate) fn run_bounded(
    executable: &Path,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<ProcessOutput> {
    run_bounded_with_limits(executable, args, cwd, MAX_PROBE_BYTES, PROBE_TIMEOUT)
}

pub(crate) fn run_bounded_with_limits(
    executable: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    max_output_bytes: u64,
    timeout: Duration,
) -> Result<ProcessOutput> {
    let mut command = probe_command(executable, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| IntegratorError::Unavailable("process stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| IntegratorError::Unavailable("process stderr unavailable".into()))?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, max_output_bytes));
    let stderr_reader = thread::spawn(move || read_limited(stderr, max_output_bytes));

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(IntegratorError::Unavailable(
                "local process probe timed out".into(),
            ));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| IntegratorError::Unavailable("stdout reader failed".into()))??;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| IntegratorError::Unavailable("stderr reader failed".into()))??;
    Ok(ProcessOutput {
        success: status.success(),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

fn read_limited(mut reader: impl Read, max_output_bytes: u64) -> Result<(String, bool)> {
    let mut retained = Vec::with_capacity((max_output_bytes.min(64 * 1024)) as usize);
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = max_output_bytes.saturating_sub(retained.len() as u64) as usize;
        let keep = count.min(remaining);
        retained.extend_from_slice(&buffer[..keep]);
        if keep < count {
            truncated = true;
        }
    }
    Ok((String::from_utf8_lossy(&retained).into_owned(), truncated))
}

fn probe_command(executable: &Path, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        if is_windows_script(executable) {
            let mut command =
                Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
            command.args(["/d", "/s", "/c"]);
            command.arg(windows_command_line(executable, args));
            return command;
        }
    }

    let mut command = Command::new(executable);
    command.args(args);
    command
}

#[cfg(windows)]
fn is_windows_script(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("bat" | "cmd")
    )
}

#[cfg(windows)]
fn windows_command_line(executable: &Path, args: &[&str]) -> String {
    std::iter::once(executable.to_string_lossy().into_owned())
        .chain(args.iter().map(|arg| (*arg).to_owned()))
        .map(|value| quote_windows_arg(&value))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
fn quote_windows_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".into();
    }
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

pub(crate) fn redact_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(1024));
    for token in value.split_whitespace().take(80) {
        let lowered = token.to_ascii_lowercase();
        let sensitive = lowered.starts_with("sk-")
            || lowered.starts_with("token=")
            || lowered.starts_with("key=")
            || lowered.starts_with("secret=")
            || (token.contains('@') && token.contains('.'));
        if !output.is_empty() {
            output.push(' ');
        }
        output.push_str(if sensitive { "[redacted]" } else { token });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_bounded_while_the_reader_is_fully_drained() {
        let input = std::io::Cursor::new(vec![b'x'; 1024]);
        let (output, truncated) = read_limited(input, 100).expect("bounded read");
        assert_eq!(output.len(), 100);
        assert!(truncated);
    }

    #[test]
    fn obvious_credentials_and_email_are_redacted() {
        let text = redact_text("failed user@example.test token=abcdef sk-not-a-real-token okay");
        assert_eq!(text, "failed [redacted] [redacted] [redacted] okay");
    }
}
