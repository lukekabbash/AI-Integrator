//! Kill-on-exit: the one thing in this feature the OS has to enforce for us.
//!
//! A `Drop` impl is not that guarantee. Drop runs on a clean shutdown and on a
//! panic unwind — not when the app is force-killed, which is exactly the
//! moment an orphaned `node.exe` is left holding port 5173, the next launch
//! fails, and the user has to hunt down a process they never started. So on
//! Windows every child is put in a job object created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: when our last handle to that job
//! closes — deliberately, on a crash, or because the kernel tore this process
//! down — every process in the job is terminated, grandchildren included. That
//! last part matters as much as the crash case: `npm run dev` is a shim that
//! spawns node, and killing only the direct child leaves the server running.
//!
//! On Unix the child gets its own process group and the group is signalled on
//! drop. There is no kernel-side equivalent to the job object there, and
//! `KILLS_ON_OWNER_DEATH` records that difference honestly so the tests assert
//! what each platform actually promises rather than what we wish it did.
//!
//! This is the only file in the feature with platform-specific code, and it
//! still contains no `unsafe`: `win32job` wraps the job-object calls and
//! `std::os::unix::process::CommandExt::process_group` covers the other side,
//! so the crate-wide `forbid(unsafe_code)` stays whole. Everything else in the
//! feature stays portable and testable.

use std::process::{Child, Command};

/// Whether the OS reaps this process's children on its own when this process
/// dies without running a single destructor. True on Windows, where the job
/// object is a kernel guarantee; false on Unix, where a process group still
/// needs somebody alive to signal it.
///
/// Only the tests read this, and that is the point: it lets them assert what
/// each platform actually promises instead of asserting the same thing
/// everywhere and being wrong on one of them.
#[cfg(test)]
pub const KILLS_ON_OWNER_DEATH: bool = platform::KILLS_ON_OWNER_DEATH;

/// Ownership of one child's whole process tree.
pub struct ProcessGuard {
    inner: platform::Inner,
}

impl ProcessGuard {
    /// Configure a command so its children can later be reaped as a unit.
    /// Must run before `spawn`.
    pub fn prepare(command: &mut Command) {
        platform::prepare(command);
    }

    /// Take ownership of a freshly spawned child.
    ///
    /// There is a hairline window between `spawn` and this call in which the
    /// child could fork something that escapes the job. Closing it would need
    /// the child's main thread handle to start it suspended, which `std` does
    /// not hand out; in practice a process has not finished loading its own
    /// runtime in that window. The caller treats a failure here as fatal and
    /// kills the child rather than keeping one it cannot guarantee to reap.
    pub fn adopt(child: &Child) -> Result<Self, String> {
        platform::adopt(child).map(|inner| Self { inner })
    }

    /// Terminate the whole tree now. Idempotent.
    pub fn kill(&mut self) {
        platform::kill(&mut self.inner);
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Whether the OS still has a running process under this id.
///
/// The registry uses it to check that a kill actually landed, and the tests
/// use it to assert against the OS rather than against our own bookkeeping —
/// "we called kill" is not the claim worth testing.
pub fn process_is_alive(pid: u32) -> bool {
    platform::process_is_alive(pid)
}

#[cfg(windows)]
mod platform {
    use std::{
        io,
        os::windows::{io::AsRawHandle, process::CommandExt},
        process::{Child, Command, Stdio},
    };

    use win32job::{ExtendedLimitInfo, Job};

    #[cfg(test)]
    pub const KILLS_ON_OWNER_DEATH: bool = true;

    /// Without this a console window flashes over the app on every start, the
    /// same reason the port scan in `browser/servers.rs` sets it.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// The job this child belongs to. `None` once it has been let go: the job
    /// owns nothing else, so dropping it is the whole of the kill.
    pub struct Inner {
        job: Option<Job>,
    }

    pub fn prepare(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    pub fn adopt(child: &Child) -> Result<Inner, String> {
        let mut limits = ExtendedLimitInfo::new();
        // The whole feature in one flag: when the last handle to this job
        // closes, for any reason at all, the kernel terminates everything
        // inside it. Set at creation so there is never an instant where the
        // job exists without it.
        limits.limit_kill_on_job_close();
        let job = Job::create_with_limit_info(&limits).map_err(|error| {
            format!(
                "the job object could not be created: {}",
                io::Error::from(error)
            )
        })?;
        // `std` holds this handle open for the lifetime of `Child`, so it is
        // valid here and needs no rights of its own.
        job.assign_process(child.as_raw_handle() as isize)
            .map_err(|error| {
                format!(
                    "the child could not be put in the job: {}",
                    io::Error::from(error)
                )
            })?;
        Ok(Inner { job: Some(job) })
    }

    pub fn kill(inner: &mut Inner) {
        // Letting the job go closes our last handle to it, and closing that
        // handle is the kill. It is deliberately the same path the OS takes
        // when the app is force-killed and no destructor of ours ever runs —
        // one mechanism, exercised on every stop, rather than a rehearsed one
        // and an untested one.
        inner.job = None;
    }

    pub fn process_is_alive(pid: u32) -> bool {
        // Asking the kernel directly means opening a process handle, and there
        // is no safe wrapper for that in the dependency set — so we read the
        // table the OS ships a tool for, the same one `browser/servers.rs`
        // parses for the port scan. A terminated process leaves that table
        // even while a handle to it is still open, which is exactly the
        // question being asked.
        let Some(listing) = run(
            "tasklist",
            &[
                "/FI".into(),
                format!("PID eq {pid}"),
                "/NH".into(),
                "/FO".into(),
                "CSV".into(),
            ],
        ) else {
            return false;
        };
        let wanted = pid.to_string();
        listing.lines().any(|row| {
            row.split("\",\"")
                .nth(1)
                .is_some_and(|field| field.trim_matches('"').trim() == wanted)
        })
    }

    fn run(program: &str, args: &[String]) -> Option<String> {
        let output = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

#[cfg(unix)]
mod platform {
    use std::{
        os::unix::process::CommandExt,
        process::{Child, Command, Stdio},
    };

    #[cfg(test)]
    pub const KILLS_ON_OWNER_DEATH: bool = false;

    /// The process group id, which equals the child's pid because `prepare`
    /// made the child a group leader. Zero means "already signalled".
    pub struct Inner {
        pgid: u32,
    }

    pub fn prepare(command: &mut Command) {
        // The child leads its own group, so signalling the group reaches the
        // shim and whatever it spawned rather than only the shim.
        command.process_group(0);
    }

    pub fn adopt(child: &Child) -> Result<Inner, String> {
        Ok(Inner { pgid: child.id() })
    }

    pub fn kill(inner: &mut Inner) {
        if inner.pgid == 0 {
            return;
        }
        let pgid = inner.pgid;
        inner.pgid = 0;
        // `libc` is not a dependency of this crate and adding one to send a
        // single signal is not worth it; `kill` is in POSIX and a negative pid
        // is how the standard spells "the whole group".
        run("kill", &["-KILL".into(), format!("-{pgid}")]);
    }

    pub fn process_is_alive(pid: u32) -> bool {
        // Signal 0 checks for existence without delivering anything. A reaped
        // child is gone here; an unreaped zombie is not, which is why the
        // registry always waits on a child it has killed.
        run("kill", &["-0".into(), pid.to_string()])
    }

    fn run(program: &str, args: &[String]) -> bool {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_running_test_process_reads_as_alive() {
        assert!(process_is_alive(std::process::id()));
    }

    #[test]
    fn an_unused_process_id_reads_as_gone() {
        // Ids this large are not handed out on either platform, so nothing can
        // be running under it while the test runs.
        assert!(!process_is_alive(u32::MAX - 4));
    }
}
