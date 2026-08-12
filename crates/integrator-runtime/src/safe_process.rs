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
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
}

pub(crate) enum ProcessRunOutcome {
    Completed(ProcessOutput),
    TimedOut,
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
    match run_bounded_with_outcome(executable, args, cwd, max_output_bytes, timeout)? {
        ProcessRunOutcome::Completed(output) => Ok(output),
        ProcessRunOutcome::TimedOut => Err(IntegratorError::Unavailable(
            "local process probe timed out".into(),
        )),
    }
}

pub(crate) fn run_bounded_with_outcome(
    executable: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    max_output_bytes: u64,
    timeout: Duration,
) -> Result<ProcessRunOutcome> {
    let mut command = probe_command(executable, args);
    suppress_windows_console(&mut command);
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
    let (stdout_sender, stdout_receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = stdout_sender.send(read_limited(stdout, max_output_bytes));
    });
    let (stderr_sender, stderr_receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = stderr_sender.send(read_limited(stderr, max_output_bytes));
    });

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(ProcessRunOutcome::TimedOut);
        }
        thread::sleep(Duration::from_millis(20));
    };
    // The child has exited, but the pipes only reach EOF once every process
    // holding the write ends does. A probed CLI that forked a daemon
    // grandchild (inheriting stdout/stderr) would otherwise hang this call
    // indefinitely despite the probe timeout above, so give the readers a
    // short grace period and then report whatever arrived as truncated.
    let (stdout, stdout_truncated) = recv_reader_output(&stdout_receiver, "stdout")?;
    let (stderr, stderr_truncated) = recv_reader_output(&stderr_receiver, "stderr")?;
    Ok(ProcessRunOutcome::Completed(ProcessOutput {
        success: status.success(),
        exit_code: status.code(),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    }))
}

fn suppress_windows_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

const PIPE_EOF_GRACE: Duration = Duration::from_secs(2);

fn recv_reader_output(
    receiver: &std::sync::mpsc::Receiver<Result<(String, bool)>>,
    label: &str,
) -> Result<(String, bool)> {
    match receiver.recv_timeout(PIPE_EOF_GRACE) {
        Ok(result) => result,
        // A grandchild is holding the pipe open past the child's exit; the
        // detached reader thread stays parked until that process exits, and
        // we return what we have instead of blocking the probe.
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok((String::new(), true)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(IntegratorError::Unavailable(
            format!("{label} reader failed"),
        )),
    }
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
            use std::os::windows::process::CommandExt;

            let mut command =
                Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
            command.args(["/d", "/s", "/c"]);
            // cmd.exe does not understand the MSVC `\"` escaping that
            // Command::arg applies, so hand it the exact `/s`-shaped line:
            // one outer quote pair that `/s` strips, leaving each part quoted.
            command.raw_arg(format!("\"{}\"", windows_command_line(executable, args)));
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

    #[cfg(unix)]
    #[test]
    fn grandchild_holding_pipes_cannot_hang_the_probe_past_the_grace_period() {
        let started = Instant::now();
        let outcome = run_bounded_with_outcome(
            Path::new("/bin/bash"),
            &["-c", "echo probed; sleep 10 & exit 0"],
            None,
            1024,
            Duration::from_secs(5),
        )
        .expect("probe run");
        // The child exits immediately; only the sleeping grandchild holds the
        // pipe write ends. The call must return after the EOF grace period,
        // not after the grandchild exits.
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "probe blocked on grandchild-held pipes for {:?}",
            started.elapsed()
        );
        match outcome {
            ProcessRunOutcome::Completed(output) => {
                assert!(output.success);
                assert!(output.stdout_truncated || output.stdout.contains("probed"));
            }
            ProcessRunOutcome::TimedOut => panic!("child exited; probe must not time out"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn cmd_script_probes_survive_cmd_exe_quoting() {
        let dir = std::env::temp_dir().join("integrator-probe-quoting-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        // A space in the path exercises the /s outer-quote stripping.
        let script = dir.join("echo args.cmd");
        std::fs::write(&script, "@echo %1 %2\r\n").expect("write script");
        let output = run_bounded(&script, &["--version", "second"], None).expect("probe run");
        assert!(output.success, "stderr: {}", output.stderr);
        assert!(output.stdout.contains("--version"));
        assert!(output.stdout.contains("second"));
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn obvious_credentials_and_email_are_redacted() {
        let text = redact_text("failed user@example.test token=abcdef sk-not-a-real-token okay");
        assert_eq!(text, "failed [redacted] [redacted] [redacted] okay");
    }
}
