/// Compares the PTY foreground process group against the shell's process id.
/// An unknown shell pid keeps interrupt available because idleness is unproven.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn foreground_process_active(
    foreground_pgrp: Option<i32>,
    shell_pid: Option<u32>,
) -> bool {
    match (foreground_pgrp, shell_pid) {
        (Some(foreground), Some(shell)) => foreground != shell as i32,
        (None, _) => false,
        (_, None) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::foreground_process_active;

    #[test]
    fn detects_when_a_job_owns_the_foreground_process_group() {
        assert!(!foreground_process_active(Some(4242), Some(4242)));
        assert!(foreground_process_active(Some(7777), Some(4242)));
        assert!(!foreground_process_active(None, Some(4242)));
        assert!(foreground_process_active(Some(7777), None));
    }
}
