use std::{fs, process::Command};

use chrono::Utc;
use integrator_core::{ProjectId, TrustedProject};

use super::*;

fn initialize_repository(root: &Path) {
    assert!(
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(root)
            .status()
            .expect("git init")
            .success()
    );
}

fn trusted_project(identity: &RepositoryIdentity) -> TrustedProject {
    let now = Utc::now();
    TrustedProject {
        id: ProjectId::new(),
        display_name: "Trusted".into(),
        repository_root: identity.root.clone(),
        git_repository_root: Some(identity.root.clone()),
        git_common_directory: Some(identity.common_directory.clone()),
        created_at: now,
        last_opened_at: now,
    }
}

fn configure_identity(root: &Path) {
    for args in [
        ["config", "user.name", "Test User"],
        ["config", "user.email", "test@example.invalid"],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(root)
                .status()
                .expect("git config")
                .success()
        );
    }
}

fn confirmation_for(preview: &PushPreview) -> PushConfirmation {
    forced_confirmation_for(preview, PushForce::Off)
}

fn forced_confirmation_for(preview: &PushPreview, force: PushForce) -> PushConfirmation {
    PushConfirmation {
        expected_head: preview.head.clone(),
        expected_branch: preview.branch.clone(),
        expected_remote: preview.remote.clone().expect("configured remote"),
        expected_remote_url: preview.sanitized_remote_url.clone(),
        expected_upstream: preview.upstream.clone().expect("configured upstream"),
        expected_refspec: preview.refspec.clone(),
        force,
    }
}

#[test]
fn ordinary_folder_requires_explicit_initialization() {
    let directory = tempfile::tempdir().expect("ordinary folder");
    let git = GitService::discover().expect("discover git");
    assert_eq!(
        git.repository_if_present(directory.path())
            .expect("detect ordinary folder"),
        None
    );

    let initialized = git.init(directory.path()).expect("initialize Git");
    assert_eq!(
        initialized.root,
        dunce::canonicalize(directory.path()).expect("canonical ordinary folder")
    );
    let configured_branch = std::process::Command::new("git")
        .args(["config", "--get", "init.defaultBranch"])
        .current_dir(directory.path())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|branch| branch.trim().to_owned())
        .filter(|branch| !branch.is_empty())
        .unwrap_or_else(|| "main".into());
    assert_eq!(
        initialized.branch.as_deref(),
        Some(configured_branch.as_str())
    );
    assert!(
        git.repository_if_present(directory.path())
            .expect("detect initialized repository")
            .is_some()
    );
}

#[test]
fn remotes_can_be_added_updated_and_removed_locally() {
    let directory = tempfile::tempdir().expect("repository");
    let first_remote = tempfile::tempdir().expect("first remote");
    let second_remote = tempfile::tempdir().expect("second remote");
    initialize_repository(directory.path());
    let git = GitService::discover().expect("discover git");

    let remotes = git
        .add_remote(
            directory.path(),
            "origin",
            &first_remote.path().to_string_lossy(),
        )
        .expect("add remote");
    assert_eq!(remotes[0].name, "origin");
    let remotes = git
        .update_remote(
            directory.path(),
            "origin",
            &second_remote.path().to_string_lossy(),
        )
        .expect("update remote");
    assert_eq!(remotes[0].fetch_url, second_remote.path().to_string_lossy());
    assert!(
        git.remove_remote(directory.path(), "origin")
            .expect("remove remote")
            .is_empty()
    );
}

#[test]
fn remote_credentials_are_removed() {
    assert_eq!(
        sanitize_remote_url("https://user:secret@example.test/org/repo.git"),
        "https://example.test/org/repo.git"
    );
    assert_eq!(
        sanitize_remote_url("git@example.test:org/repo.git"),
        "git@example.test:org/repo.git"
    );
    assert_eq!(
        sanitize_remote_url("https://example.test/org/repo.git?access_token=not-real"),
        "https://example.test/org/repo.git"
    );
}

#[test]
fn remote_urls_reject_command_transports_and_embedded_https_credentials() {
    assert!(validate_remote_url("ext::sh -c touch /tmp/unsafe").is_err());
    assert!(validate_remote_url("https://user:secret@example.test/repo.git").is_err());
    assert!(validate_remote_url("ssh://git@example.test/org/repo.git").is_ok());
    assert!(validate_remote_url("git@example.test:org/repo.git").is_ok());
}

#[test]
fn git_status_diff_stage_commit_and_preview() {
    if which::which("git").is_err() {
        return;
    }
    let directory = tempfile::tempdir().expect("temp repo");
    let root = directory.path();
    assert!(
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(root)
            .status()
            .expect("git init")
            .success()
    );
    for args in [
        ["config", "user.name", "Test User"],
        ["config", "user.email", "test@example.invalid"],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(root)
                .status()
                .expect("git config")
                .success()
        );
    }
    fs::write(root.join("sample.txt"), "hello\n").expect("write fixture");
    let git = GitService::discover().expect("discover git");
    assert_eq!(git.status(root).expect("status").len(), 1);
    let untracked = git
        .diff(root, DiffScope::Untracked, Some(Path::new("sample.txt")))
        .expect("untracked diff");
    assert!(untracked.patch.contains("+hello"));
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage");
    let staged = git
        .diff(root, DiffScope::Staged, None)
        .expect("staged diff");
    assert!(staged.patch.contains("+hello"));
    git.commit(root, "Initial fixture").expect("commit");
    let history = git.history(root).expect("history");
    assert_eq!(history[0].subject, "Initial fixture");
    assert!(history[0].current);
    fs::write(root.join("sample.txt"), "hello\nworld\n").expect("modify fixture");
    let identity = git.repository(root).expect("authorized identity");
    let overview = git.overview(&identity).expect("overview");
    assert_eq!(overview.identity.branch.as_deref(), Some("main"));
    assert_eq!(overview.history[0].subject, "Initial fixture");
    assert_eq!(overview.files.len(), 1);
    assert_eq!(overview.files[0].path, PathBuf::from("sample.txt"));
    assert_eq!(overview.files[0].worktree_status, 'M');
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage first tranche");
    fs::write(root.join("sample.txt"), "hello\nworld\nlater\n").expect("write unstaged remainder");
    let overview = git.overview(&identity).expect("partially staged overview");
    assert_eq!(overview.files[0].index_status, 'M');
    assert_eq!(overview.files[0].worktree_status, 'M');
    assert_eq!(overview.files[0].staged_additions, Some(1));
    assert_eq!(overview.files[0].unstaged_additions, Some(1));
    assert_eq!(
        overview
            .push_preview
            .as_ref()
            .map(|preview| preview.branch.as_str()),
        Some("main")
    );
    let preview = git.push_preview(root).expect("preview");
    assert!(preview.head.starts_with(&history[0].id));
    assert_eq!(preview.branch, "main");
}

#[test]
fn stage_reaches_tracked_files_under_a_later_ignored_directory_without_force() {
    let directory = tempfile::tempdir().expect("temp repo");
    let root = directory.path();
    initialize_repository(root);
    configure_identity(root);
    fs::create_dir_all(root.join("temp/docs")).expect("fixture dir");
    fs::write(root.join("temp/docs/notes.md"), "v1\n").expect("tracked fixture");
    let git = GitService::discover().expect("discover git");
    git.stage(root, &[PathBuf::from("temp/docs/notes.md")])
        .expect("stage before ignore rule");
    git.commit(root, "Track notes").expect("commit");
    // The ignore rule arrives after the file was committed, which is exactly
    // the layout that makes plain `git add <path>` refuse the path.
    fs::write(root.join(".gitignore"), "/temp/\n").expect("ignore rule");
    fs::write(root.join("temp/docs/notes.md"), "v2\n").expect("modify tracked");
    fs::write(root.join("temp/scratch.md"), "never staged\n").expect("ignored untracked");

    let files = git
        .stage(root, &[PathBuf::from("temp/docs/notes.md")])
        .expect("stage tracked file under ignored directory");
    let notes = files
        .iter()
        .find(|file| file.path == PathBuf::from("temp/docs/notes.md"))
        .expect("notes row");
    assert_eq!(notes.index_status, 'M');
    assert!(
        files.iter().all(|file| file.path != PathBuf::from("temp/scratch.md")),
        "ignored untracked file must never be staged: {files:?}"
    );

    // Selecting the directory itself also stages only what is tracked.
    fs::write(root.join("temp/docs/notes.md"), "v3\n").expect("modify again");
    let files = git
        .stage(root, &[PathBuf::from("temp")])
        .expect("stage ignored directory containing tracked files");
    assert!(files.iter().all(|file| file.path != PathBuf::from("temp/scratch.md")));
    let staged = git.diff(root, DiffScope::Staged, None).expect("staged diff");
    assert!(staged.patch.contains("+v3"));
}

#[test]
fn confirmed_push_updates_only_the_previewed_branch_and_head() {
    if which::which("git").is_err() {
        return;
    }
    let local_directory = tempfile::tempdir().expect("local repo");
    let remote_directory = tempfile::tempdir().expect("bare remote");
    let root = local_directory.path();
    initialize_repository(root);
    configure_identity(root);
    assert!(
        Command::new("git")
            .args(["init", "--bare"])
            .current_dir(remote_directory.path())
            .status()
            .expect("bare git init")
            .success()
    );
    let remote_path = remote_directory.path().to_string_lossy().into_owned();
    assert!(
        Command::new("git")
            .args(["remote", "add", "origin", &remote_path])
            .current_dir(root)
            .status()
            .expect("git remote add")
            .success()
    );
    let git = GitService::discover().expect("discover git");
    fs::write(root.join("sample.txt"), "initial\n").expect("write initial fixture");
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage initial fixture");
    git.commit(root, "Initial fixture").expect("initial commit");
    assert!(
        Command::new("git")
            .args(["push", "-u", "origin", "main"])
            .current_dir(root)
            .status()
            .expect("initial push")
            .success()
    );

    fs::write(root.join("sample.txt"), "initial\nnext\n").expect("write next fixture");
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage next fixture");
    let commit = git.commit(root, "Next fixture").expect("next commit");
    let preview = git.push_preview(root).expect("push preview");
    assert_eq!(preview.ahead, 1);
    let result = git
        .push_confirmed(root, &confirmation_for(&preview))
        .expect("confirmed push");

    assert_eq!(result.outcome, PushOutcome::Pushed);
    assert_eq!(result.head, commit.commit);
    assert_eq!(
        git.required(remote_directory.path(), &["rev-parse", "refs/heads/main"])
            .expect("remote head")
            .trim(),
        commit.commit
    );
}

#[test]
fn force_modes_map_to_the_flag_they_promise() {
    assert_eq!(PushForce::Off.flag(), None);
    assert_eq!(PushForce::Lease.flag(), Some("--force-with-lease"));
    assert_eq!(PushForce::Always.flag(), Some("--force"));
    // A payload with no force field means the safe mode, never a remembered one.
    assert_eq!(PushForce::default(), PushForce::Off);
}

#[test]
fn a_forced_push_rewrites_remote_history_only_when_the_confirmation_asks_for_it() {
    if which::which("git").is_err() {
        return;
    }
    let local_directory = tempfile::tempdir().expect("local repo");
    let remote_directory = tempfile::tempdir().expect("bare remote");
    let root = local_directory.path();
    initialize_repository(root);
    configure_identity(root);
    assert!(
        Command::new("git")
            .args(["init", "--bare"])
            .current_dir(remote_directory.path())
            .status()
            .expect("bare git init")
            .success()
    );
    let remote_path = remote_directory.path().to_string_lossy().into_owned();
    assert!(
        Command::new("git")
            .args(["remote", "add", "origin", &remote_path])
            .current_dir(root)
            .status()
            .expect("git remote add")
            .success()
    );
    let git = GitService::discover().expect("discover git");
    fs::write(root.join("sample.txt"), "initial\n").expect("write initial fixture");
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage initial fixture");
    git.commit(root, "Initial fixture").expect("initial commit");
    assert!(
        Command::new("git")
            .args(["push", "-u", "origin", "main"])
            .current_dir(root)
            .status()
            .expect("initial push")
            .success()
    );

    // Rewrite the commit that was already pushed, so the local branch and
    // the remote diverge and only a forced push can reconcile them.
    fs::write(root.join("sample.txt"), "rewritten\n").expect("write rewritten fixture");
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage rewritten fixture");
    assert!(
        Command::new("git")
            .args(["commit", "--amend", "-m", "Rewritten fixture"])
            .current_dir(root)
            .status()
            .expect("git commit --amend")
            .success()
    );

    let preview = git.push_preview(root).expect("push preview");
    assert_eq!((preview.ahead, preview.behind), (1, 1));
    // The ordinary confirmation carries no force mode, so a diverged push
    // is refused rather than quietly rewriting the remote.
    assert!(
        git.push_confirmed(root, &confirmation_for(&preview))
            .is_err()
    );

    let result = git
        .push_confirmed(root, &forced_confirmation_for(&preview, PushForce::Lease))
        .expect("leased force push");
    assert_eq!(result.outcome, PushOutcome::Pushed);
    assert_eq!(
        git.required(remote_directory.path(), &["rev-parse", "refs/heads/main"])
            .expect("remote head")
            .trim(),
        preview.head
    );
}

#[test]
fn confirmed_push_rejects_a_head_changed_after_preview() {
    if which::which("git").is_err() {
        return;
    }
    let local_directory = tempfile::tempdir().expect("local repo");
    let remote_directory = tempfile::tempdir().expect("bare remote");
    let root = local_directory.path();
    initialize_repository(root);
    configure_identity(root);
    assert!(
        Command::new("git")
            .args(["init", "--bare"])
            .current_dir(remote_directory.path())
            .status()
            .expect("bare git init")
            .success()
    );
    let remote_path = remote_directory.path().to_string_lossy().into_owned();
    assert!(
        Command::new("git")
            .args(["remote", "add", "origin", &remote_path])
            .current_dir(root)
            .status()
            .expect("git remote add")
            .success()
    );
    let git = GitService::discover().expect("discover git");
    fs::write(root.join("sample.txt"), "initial\n").expect("write initial fixture");
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage initial fixture");
    let initial = git.commit(root, "Initial fixture").expect("initial commit");
    assert!(
        Command::new("git")
            .args(["push", "-u", "origin", "main"])
            .current_dir(root)
            .status()
            .expect("initial push")
            .success()
    );

    fs::write(root.join("sample.txt"), "initial\npreviewed\n").expect("write preview fixture");
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage preview fixture");
    git.commit(root, "Previewed fixture")
        .expect("previewed commit");
    let confirmation = confirmation_for(&git.push_preview(root).expect("push preview"));
    fs::write(root.join("sample.txt"), "initial\npreviewed\nchanged\n")
        .expect("write changed fixture");
    git.stage(root, &[PathBuf::from("sample.txt")])
        .expect("stage changed fixture");
    git.commit(root, "Changed after preview")
        .expect("changed commit");

    let error = git
        .push_confirmed(root, &confirmation)
        .expect_err("stale confirmation must fail");
    assert!(error.to_string().contains("state changed"));
    assert_eq!(
        git.required(remote_directory.path(), &["rev-parse", "refs/heads/main"])
            .expect("remote head")
            .trim(),
        initial.commit
    );
}

#[test]
fn porcelain_v2_overview_preserves_paths_and_branch_counts() {
    let output = concat!(
        "# branch.oid abcdef\0",
        "# branch.head feature/smooth\0",
        "# branch.upstream origin/feature/smooth\0",
        "# branch.ab +3 -2\0",
        "1 .M N... 100644 100644 100644 aaaaaa bbbbbb path with spaces.txt\0",
        "2 R. N... 100644 100644 100644 aaaaaa bbbbbb R100 renamed file.txt\0",
        "old file.txt\0",
        "? untracked file.txt\0",
    );
    let parsed = parse_porcelain_v2(output, true);
    assert_eq!(parsed.head.as_deref(), Some("abcdef"));
    assert_eq!(parsed.branch.as_deref(), Some("feature/smooth"));
    assert_eq!(parsed.upstream.as_deref(), Some("origin/feature/smooth"));
    assert_eq!((parsed.ahead, parsed.behind), (3, 2));
    assert_eq!(parsed.files.len(), 3);
    assert_eq!(parsed.files[0].path, PathBuf::from("path with spaces.txt"));
    assert_eq!(parsed.files[0].index_status, ' ');
    assert_eq!(parsed.files[0].worktree_status, 'M');
    assert_eq!(parsed.files[1].path, PathBuf::from("renamed file.txt"));
    assert_eq!(parsed.files[1].index_status, 'R');
    assert_eq!(parsed.files[2].path, PathBuf::from("untracked file.txt"));
}

#[test]
fn paths_cannot_escape_repository() {
    assert!(validate_relative_path(Path::new("../secret")).is_err());
    assert!(validate_relative_path(Path::new("src/lib.rs")).is_ok());
}

#[test]
fn revision_cannot_be_interpreted_as_an_option() {
    assert!(validate_revision("main").is_ok());
    assert!(validate_revision("HEAD~2").is_ok());
    assert!(validate_revision("--force").is_err());
}

#[test]
fn repository_identity_is_canonical_from_nested_directory() {
    if which::which("git").is_err() {
        return;
    }
    let directory = tempfile::tempdir().expect("temp repo");
    initialize_repository(directory.path());
    let nested = directory.path().join("nested").join("child");
    fs::create_dir_all(&nested).expect("nested fixture");
    let identity = GitService::discover()
        .expect("discover git")
        .repository(&nested)
        .expect("repository identity");
    assert_eq!(
        identity.root,
        dunce::canonicalize(directory.path()).expect("canonical root")
    );
    assert_eq!(
        identity.common_directory,
        dunce::canonicalize(directory.path().join(".git")).expect("canonical git directory")
    );
}

#[test]
fn untrusted_repository_is_rejected() {
    if which::which("git").is_err() {
        return;
    }
    let trusted_directory = tempfile::tempdir().expect("trusted repo");
    let untrusted_directory = tempfile::tempdir().expect("untrusted repo");
    initialize_repository(trusted_directory.path());
    initialize_repository(untrusted_directory.path());
    let git = GitService::discover().expect("discover git");
    let identity = git
        .repository(trusted_directory.path())
        .expect("trusted identity");
    let now = Utc::now();
    let projects = vec![TrustedProject {
        id: ProjectId::new(),
        display_name: "Trusted".into(),
        repository_root: identity.root.clone(),
        git_repository_root: Some(identity.root),
        git_common_directory: Some(identity.common_directory),
        created_at: now,
        last_opened_at: now,
    }];
    let error = authorize_repository(&git, &projects, untrusted_directory.path())
        .expect_err("untrusted repository must fail");
    assert!(error.to_string().contains("trusted project"));
}

#[test]
fn listed_worktree_of_trusted_project_is_authorized() {
    if which::which("git").is_err() {
        return;
    }
    let directory = tempfile::tempdir().expect("trusted repo");
    let worktree_parent = tempfile::tempdir().expect("worktree parent");
    let worktree_path = worktree_parent.path().join("agent-worktree");
    initialize_repository(directory.path());
    for args in [
        ["config", "user.name", "Test User"],
        ["config", "user.email", "test@example.invalid"],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(directory.path())
                .status()
                .expect("git config")
                .success()
        );
    }
    fs::write(directory.path().join("fixture.txt"), "fixture\n").expect("write fixture");
    let git = GitService::discover().expect("discover git");
    git.stage(directory.path(), &[PathBuf::from("fixture.txt")])
        .expect("stage fixture");
    git.commit(directory.path(), "Initial fixture")
        .expect("commit fixture");
    let identity = git.repository(directory.path()).expect("trusted identity");
    let now = Utc::now();
    let projects = vec![TrustedProject {
        id: ProjectId::new(),
        display_name: "Trusted".into(),
        repository_root: identity.root.clone(),
        git_repository_root: Some(identity.root.clone()),
        git_common_directory: Some(identity.common_directory.clone()),
        created_at: now,
        last_opened_at: now,
    }];
    git.create_worktree(
        &identity.root,
        &CreateWorktree {
            destination: worktree_path.clone(),
            branch: "agent/fixture".into(),
            base_ref: Some("HEAD".into()),
        },
    )
    .expect("create worktree");

    let authorized = authorize_repository(&git, &projects, &worktree_path)
        .expect("listed worktree must be authorized");
    assert_eq!(
        authorized.root,
        dunce::canonicalize(&worktree_path).expect("canonical worktree")
    );
    let mut cache = AuthorizedRepositoryCache::default();
    cache
        .authorize(&git, &projects, &worktree_path)
        .expect("cache linked worktree");
    let unavailable_git = GitService {
        executable: directory.path().join("missing-git-executable"),
    };
    let cached = cache
        .authorize(&unavailable_git, &projects, &worktree_path)
        .expect("linked worktree cache hit must not spawn Git");
    assert_eq!(cached.root, authorized.root);
}

#[test]
fn cached_authorization_is_revoked_when_project_is_removed() {
    if which::which("git").is_err() {
        return;
    }
    let directory = tempfile::tempdir().expect("trusted repo");
    initialize_repository(directory.path());
    let git = GitService::discover().expect("discover git");
    let identity = git
        .repository(directory.path())
        .expect("repository identity");
    let mut projects = vec![trusted_project(&identity)];
    let mut cache = AuthorizedRepositoryCache::default();

    let authorized = cache
        .authorize(&git, &projects, directory.path())
        .expect("first authorization");
    assert_eq!(authorized.root, identity.root);
    assert_eq!(cache.cached_entry_count(), 1);

    projects.clear();
    let error = cache
        .authorize(&git, &projects, directory.path())
        .expect_err("removed project must revoke cached trust");
    assert!(error.to_string().contains("trusted project"));
    assert_eq!(cache.cached_entry_count(), 0);
}

#[test]
fn cached_authorization_requires_the_original_git_layout() {
    if which::which("git").is_err() {
        return;
    }
    let directory = tempfile::tempdir().expect("trusted repo");
    initialize_repository(directory.path());
    let git = GitService::discover().expect("discover git");
    let identity = git
        .repository(directory.path())
        .expect("repository identity");
    let projects = vec![trusted_project(&identity)];
    let mut cache = AuthorizedRepositoryCache::default();
    cache
        .authorize(&git, &projects, directory.path())
        .expect("first authorization");

    let git_directory = directory.path().join(".git");
    let moved_git_directory = directory.path().join(".git-away");
    fs::rename(&git_directory, &moved_git_directory).expect("move git directory");
    let error = cache
        .authorize(&git, &projects, directory.path())
        .expect_err("changed Git layout must invalidate cache");
    fs::rename(&moved_git_directory, &git_directory).expect("restore git directory");

    assert!(!error.to_string().is_empty());
    assert_eq!(cache.cached_entry_count(), 0);
}

#[test]
fn refreshed_identity_observes_branch_changes_after_cache_hits() {
    if which::which("git").is_err() {
        return;
    }
    let directory = tempfile::tempdir().expect("trusted repo");
    initialize_repository(directory.path());
    let git = GitService::discover().expect("discover git");
    let identity = git
        .repository(directory.path())
        .expect("repository identity");
    let projects = vec![trusted_project(&identity)];
    let mut cache = AuthorizedRepositoryCache::default();
    cache
        .authorize(&git, &projects, directory.path())
        .expect("first authorization");
    assert!(
        Command::new("git")
            .args(["checkout", "-b", "feature/cache-refresh"])
            .current_dir(directory.path())
            .status()
            .expect("create branch")
            .success()
    );

    let unavailable_git = GitService {
        executable: directory.path().join("missing-git-executable"),
    };
    let structural = cache
        .authorize(&unavailable_git, &projects, directory.path())
        .expect("cached authorization");
    assert_eq!(cache.cached_entry_count(), 1);
    assert_eq!(structural.branch, None);
    assert_eq!(structural.head, None);
    let refreshed = git
        .refresh_identity(&structural)
        .expect("refresh volatile identity");
    assert_eq!(refreshed.branch.as_deref(), Some("feature/cache-refresh"));
    assert_eq!(refreshed.head, None);
}
