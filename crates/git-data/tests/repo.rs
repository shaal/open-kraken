//! Reads real repositories: the demo fixture (docs/fixtures/make-demo-repo.sh)
//! and small repositories built per test. Needs git 2.32+ and bash.
#![cfg(unix)]

mod common;

use std::collections::HashSet;
use std::process::Command;

use common::*;
use git_data::{GitError, Head, RefKind, Repo};
use serde_json::json;
use tempfile::TempDir;

#[test]
fn log_matches_git_rev_list_and_skips_stash_commits() {
    let (_tmp, path, _) = fixture();
    let commits = Repo::open(&path).unwrap().log().unwrap();
    assert_eq!(commits.len(), 19);

    let ours: HashSet<&str> = commits.iter().map(|c| c.sha.as_str()).collect();
    let want = git(&path, &["rev-list", "--branches", "--remotes", "--tags"]);
    let want: HashSet<&str> = want.lines().collect();
    assert_eq!(ours, want);
    assert!(!ours.contains(STASH));
    let stash_index = git(&path, &["rev-parse", "refs/stash^2"]);
    assert!(!ours.contains(stash_index.trim()));

    // Children before parents.
    let position: std::collections::HashMap<&str, usize> = commits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.sha.as_str(), i))
        .collect();
    for (i, c) in commits.iter().enumerate() {
        for p in &c.parents {
            assert!(position[p.as_str()] > i, "{} listed before its child", p);
        }
    }

    let main = commits.iter().find(|c| c.sha == MAIN).unwrap();
    assert_eq!(main.subject, "Update roadmap");
    assert_eq!(main.author_name, "Alice");
    assert_eq!(main.author_email, "alice@example.com");
    let merge = commits.iter().find(|c| c.sha == ORIGIN_MAIN).unwrap();
    assert_eq!(merge.subject, "Merge branch 'release/1.1'");
    assert_eq!(merge.parents.len(), 2);
    let roots: Vec<_> = commits.iter().filter(|c| c.parents.is_empty()).collect();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].subject, "Initial commit");
    assert_eq!(roots[0].author_time, 1_759_300_000 + 7200);
    assert_eq!(roots[0].committer_time, roots[0].author_time);
}

#[test]
fn refs_of_the_fixture() {
    let (_tmp, path, _) = fixture();
    let refs = Repo::open(&path).unwrap().refs().unwrap();
    assert_eq!(
        refs.head,
        Head::Branch {
            name: "refs/heads/main".into(),
            short_name: "main".into(),
            sha: Some(MAIN.into())
        }
    );
    let names = |kind| {
        refs.refs
            .iter()
            .filter(|r| r.kind == kind)
            .map(|r| r.short_name.as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(RefKind::LocalBranch),
        [
            "bugfix/crash-on-start",
            "feature/graph-view",
            "feature/login",
            "main",
            "release/1.1"
        ]
    );
    assert_eq!(
        names(RefKind::RemoteBranch),
        [
            "origin/bugfix/crash-on-start",
            "origin/feature/login",
            "origin/main"
        ]
    );
    assert_eq!(names(RefKind::Tag), ["v1.0", "v1.1"]);
    for r in &refs.refs {
        assert_eq!(r.upstream, None, "the fixture sets no upstreams");
        assert!(!r.annotated);
        assert_eq!(
            r.remote.as_deref(),
            (r.kind == RefKind::RemoteBranch).then_some("origin")
        );
        assert_eq!(r.sha, git(&path, &["rev-parse", &r.name]).trim());
    }
}

#[test]
fn upstreams_and_annotated_tags() {
    let (_tmp, path, _) = fixture();
    git(
        &path,
        &["branch", "-q", "--set-upstream-to=origin/main", "main"],
    );
    git(
        &path,
        &["tag", "-a", "-m", "annotated", "v2", "feature/login"],
    );
    git(&path, &["tag", "-a", "-m", "nested", "v2-nested", "v2"]);
    git(&path, &["tag", "tree-tag", "main^{tree}"]);
    let refs = Repo::open(&path).unwrap().refs().unwrap();
    let get = |name: &str| refs.refs.iter().find(|r| r.name == name).cloned();

    assert_eq!(
        get("refs/heads/main").unwrap().upstream.as_deref(),
        Some("refs/remotes/origin/main")
    );
    let login = git(&path, &["rev-parse", "feature/login"]);
    for tag in ["refs/tags/v2", "refs/tags/v2-nested"] {
        let t = get(tag).unwrap();
        assert!(t.annotated, "{tag}");
        assert_eq!(t.sha, login.trim(), "{tag} peeled to the commit");
    }
    assert!(get("refs/tags/tree-tag").is_none(), "tag of a tree skipped");
    // The log still works with a tree tag present.
    assert_eq!(Repo::open(&path).unwrap().log().unwrap().len(), 19);
}

#[test]
fn detached_head_commits_are_in_the_log() {
    let (_tmp, path, _) = fixture();
    git(&path, &["stash", "-q", "-u"]);
    git(&path, &["checkout", "-q", "--detach", "v1.0"]);
    let orphan = commit_file(&path, "detached.txt", "Only reachable from HEAD");
    let repo = Repo::open(&path).unwrap();
    assert_eq!(
        repo.refs().unwrap().head,
        Head::Detached {
            sha: orphan.clone()
        }
    );
    let log = repo.log().unwrap();
    assert_eq!(log.len(), 20);
    assert_eq!(log[0].sha, orphan, "newest commit first");
}

#[test]
fn empty_repository_has_no_commits_and_an_unborn_head() {
    let (_tmp, path) = new_repo();
    let repo = Repo::open(&path).unwrap();
    assert_eq!(repo.log().unwrap(), Vec::new());
    let refs = repo.refs().unwrap();
    assert_eq!(
        refs.head,
        Head::Branch {
            name: "refs/heads/main".into(),
            short_name: "main".into(),
            sha: None
        }
    );
    assert!(refs.refs.is_empty());
}

#[test]
fn open_errors_are_typed() {
    let tmp = TempDir::new().unwrap();
    assert!(matches!(
        Repo::open(tmp.path()),
        Err(GitError::NotARepository(_))
    ));
    let missing = tmp.path().join("missing");
    assert!(matches!(
        Repo::open(&missing),
        Err(GitError::PathNotFound(p)) if p == missing
    ));
    let file = tmp.path().join("file.txt");
    std::fs::write(&file, "x").unwrap();
    assert!(matches!(Repo::open(&file), Err(GitError::PathNotFound(_))));
    let message = Repo::open(tmp.path()).unwrap_err().to_string();
    assert!(
        message.ends_with("is not inside a git repository"),
        "{message}"
    );
}

#[test]
fn paths_with_spaces_and_only_the_root_opens() {
    let (_tmp, path, _) = fixture_in("dir with spaces");
    let repo = Repo::open(&path).unwrap();
    assert_eq!(
        repo.work_dir().unwrap().canonicalize().unwrap(),
        path.canonicalize().unwrap()
    );
    assert_eq!(repo.log().unwrap().len(), 19);

    // A subfolder or the .git directory names the root to open instead.
    std::fs::create_dir(path.join("sub dir")).unwrap();
    for inside in [path.join("sub dir"), path.join(".git")] {
        match Repo::open(&inside) {
            Err(GitError::NotRepositoryRoot { path: p, root }) => {
                assert_eq!(p, inside);
                assert_eq!(root.canonicalize().unwrap(), path.canonicalize().unwrap());
            }
            other => panic!("{inside:?}: {other:?}"),
        }
    }
    let message = Repo::open(path.join("sub dir")).unwrap_err().to_string();
    assert!(message.ends_with("open that folder instead"), "{message}");

    // A symlink to the root is the root.
    let link = path.parent().unwrap().join("link to repo");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(Repo::open(&link).is_ok());
}

#[test]
fn bare_repository() {
    let (_tmp, _, origin) = fixture();
    let repo = Repo::open(&origin).unwrap();
    assert_eq!(repo.work_dir(), None);
    assert_eq!(
        repo.git_dir().canonicalize().unwrap(),
        origin.canonicalize().unwrap()
    );
    let refs = repo.refs().unwrap();
    assert_eq!(
        refs.head,
        Head::Branch {
            name: "refs/heads/main".into(),
            short_name: "main".into(),
            sha: Some(ORIGIN_MAIN.into())
        }
    );
    assert_eq!(refs.refs.len(), 3);
    assert!(repo.log().unwrap().iter().any(|c| c.sha == ORIGIN_MAIN));
}

#[test]
fn unusual_messages_do_not_break_parsing() {
    let (_tmp, path) = new_repo();
    commit_file(&path, "a", "tab\there, 100% %s %H %x00 émoji 🐙");
    commit_file(
        &path,
        "b",
        "subject line\n\nbody line 1\nbody line 2\n\n\tindented",
    );
    // Raw ISO-8859-1 bytes, with no encoding header.
    std::fs::write(path.join("msg"), b"caf\xe9 au lait\n").unwrap();
    std::fs::write(path.join("c"), "c").unwrap();
    git(&path, &["add", "c"]);
    git(&path, &["commit", "-q", "-F", "msg"]);
    commit_file(&path, "d", "after the latin-1 one");

    let log = Repo::open(&path).unwrap().log().unwrap();
    let subjects: Vec<&str> = log.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects.len(), 4);
    assert_eq!(
        subjects[0], "after the latin-1 one",
        "fields after it are not shifted"
    );
    // Git may re-encode the Latin-1 bytes; if it passes them through, we replace them.
    assert!(
        ["café au lait", "caf\u{fffd} au lait"].contains(&subjects[1]),
        "{:?}",
        subjects[1]
    );
    assert_eq!(subjects[2], "subject line");
    assert_eq!(subjects[3], "tab\there, 100% %s %H %x00 émoji 🐙");
}

#[test]
fn repository_config_cannot_change_the_output_format() {
    let (_tmp, path, _) = fixture();
    for (key, value) in [
        ("color.ui", "always"),
        ("log.showSignature", "true"),
        ("log.decorate", "full"),
        ("log.abbrevCommit", "true"),
        ("format.pretty", "oneline"),
        ("log.date", "relative"),
        ("i18n.logOutputEncoding", "ISO-8859-1"),
    ] {
        git(&path, &["config", key, value]);
    }
    // A commit whose message is stored in Latin-1, with an encoding header.
    git(&path, &["stash", "-q", "-u"]);
    std::fs::write(path.join("latin1-msg"), b"caf\xe9 au lait\n").unwrap();
    git(
        &path,
        &[
            "-c",
            "i18n.commitEncoding=ISO-8859-1",
            "commit",
            "-q",
            "--allow-empty",
            "-F",
            "latin1-msg",
        ],
    );
    let repo = Repo::open(&path).unwrap();
    let log = repo.log().unwrap();
    assert_eq!(log.len(), 20);
    assert_eq!(log[0].subject, "café au lait", "output forced to UTF-8");
    assert_ne!(
        log[0].author_time, 0,
        "--date=raw is not overridden by log.date"
    );
    assert_eq!(repo.refs().unwrap().refs.len(), 10);
}

#[test]
fn shallow_clone_boundary_commits_have_no_parents() {
    let (tmp, path, _) = fixture();
    let shallow = tmp.path().join("shallow");
    let url = format!("file://{}", path.display());
    let target = shallow.to_str().unwrap();
    git(tmp.path(), &["clone", "-q", "--depth", "2", &url, target]);
    let log = Repo::open(&shallow).unwrap().log().unwrap();
    let shas: HashSet<&str> = log.iter().map(|c| c.sha.as_str()).collect();
    for c in &log {
        for p in &c.parents {
            assert!(
                shas.contains(p.as_str()),
                "parent {p} of {} is listed",
                c.sha
            );
        }
    }
    let boundary = std::fs::read_to_string(shallow.join(".git/shallow")).unwrap();
    for sha in boundary.lines() {
        let c = log
            .iter()
            .find(|c| c.sha == sha)
            .expect("boundary commit listed");
        assert!(c.parents.is_empty(), "git grafts the boundary as a root");
    }
    assert!(log.iter().any(|c| c.sha == MAIN));
}

#[test]
fn author_time_zone_is_kept() {
    let (_tmp, path) = new_repo();
    std::fs::write(path.join("f"), "x").unwrap();
    git(&path, &["add", "f"]);
    let out = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["commit", "-q", "-m", "zoned"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Zed")
        .env("GIT_AUTHOR_EMAIL", "zed@example.com")
        .env("GIT_AUTHOR_DATE", "@1700000000 +0530")
        .env("GIT_COMMITTER_NAME", "Zed")
        .env("GIT_COMMITTER_EMAIL", "zed@example.com")
        .env("GIT_COMMITTER_DATE", "@1700000100 -0700")
        .output()
        .unwrap();
    assert!(out.status.success());
    let commit = &Repo::open(&path).unwrap().log().unwrap()[0];
    assert_eq!(commit.author_time, 1_700_000_000);
    assert_eq!(commit.author_tz_offset, 5 * 60 + 30);
    assert_eq!(commit.committer_time, 1_700_000_100);
}

#[test]
fn a_commit_with_an_unreadable_date_does_not_hide_the_history() {
    let (_tmp, path) = new_repo();
    let good = commit_file(&path, "f", "good");
    let tree = git(&path, &["rev-parse", "HEAD^{tree}"]);
    let bad = format!(
        "tree {}\nparent {good}\nauthor Bad <bad@x> 99999999999999999999999 +0000\n\
         committer Bad <bad@x> 99999999999999999999999 +0000\n\nbad date\n",
        tree.trim()
    );
    std::fs::write(path.join("bad-commit"), bad).unwrap();
    let bad = git(
        &path,
        &[
            "hash-object",
            "-t",
            "commit",
            "--literally",
            "-w",
            "bad-commit",
        ],
    );
    git(&path, &["update-ref", "refs/heads/bad", bad.trim()]);
    let log = Repo::open(&path).unwrap().log().unwrap();
    assert_eq!(log.len(), 2);
    let bad = log.iter().find(|c| c.subject == "bad date").unwrap();
    assert_eq!((bad.author_time, bad.committer_time), (0, 0));
    assert!(log.iter().any(|c| c.sha == good));
}

#[test]
fn json_shape_for_the_frontend() {
    let (_tmp, path, _) = fixture();
    let repo = Repo::open(&path).unwrap();
    let log = repo.log().unwrap();
    let main = log.iter().find(|c| c.sha == MAIN).unwrap();
    let value = serde_json::to_value(main).unwrap();
    let keys: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "authorEmail",
            "authorName",
            "authorTime",
            "authorTzOffset",
            "committerTime",
            "parents",
            "sha",
            "subject"
        ]
    );
    let refs = serde_json::to_value(repo.refs().unwrap()).unwrap();
    assert_eq!(
        refs["head"],
        json!({"type": "branch", "name": "refs/heads/main", "shortName": "main", "sha": MAIN})
    );
    assert_eq!(
        refs["refs"][0],
        json!({
            "name": "refs/heads/bugfix/crash-on-start",
            "shortName": "bugfix/crash-on-start",
            "kind": "localBranch",
            "remote": null,
            "sha": "c6653c402cd8f455bddb27ba21d10896ff9f071b",
            "annotated": false,
            "upstream": null
        })
    );
    let detached = serde_json::to_value(Head::Detached { sha: MAIN.into() }).unwrap();
    assert_eq!(detached, json!({"type": "detached", "sha": MAIN}));
}

#[test]
fn linked_worktrees_and_separate_git_dirs() {
    let (tmp, path, _) = fixture();
    let wt = tmp.path().join("wt");
    git(
        &path,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "wt-branch",
            wt.to_str().unwrap(),
            "v1.0",
        ],
    );

    // The linked worktree's root opens; it shares the history.
    let repo = Repo::open(&wt).unwrap();
    assert_eq!(
        repo.work_dir().unwrap().canonicalize().unwrap(),
        wt.canonicalize().unwrap()
    );
    assert_eq!(repo.log().unwrap().len(), 19);
    match repo.refs().unwrap().head {
        Head::Branch { short_name, .. } => assert_eq!(short_name, "wt-branch"),
        other => panic!("{other:?}"),
    }

    // Its .git file and its admin directory point at the worktree root.
    let admin = path.join(".git/worktrees/wt");
    for inside in [wt.join(".git"), admin] {
        match Repo::open(&inside) {
            Err(GitError::NotRepositoryRoot { root, .. }) => {
                assert_eq!(
                    root.canonicalize().unwrap(),
                    wt.canonicalize().unwrap(),
                    "{inside:?}"
                );
            }
            other => panic!("{inside:?}: {other:?}"),
        }
    }

    // A separate git dir is never opened as if it were a work tree.
    let r2 = tmp.path().join("r2");
    let sep = tmp.path().join("sep.git");
    git(
        tmp.path(),
        &[
            "init",
            "-q",
            "--separate-git-dir",
            sep.to_str().unwrap(),
            r2.to_str().unwrap(),
        ],
    );
    assert!(matches!(Repo::open(&sep), Err(GitError::NotARepository(_))));
    let opened = Repo::open(&r2).unwrap();
    assert_eq!(
        opened.work_dir().unwrap().canonicalize().unwrap(),
        r2.canonicalize().unwrap()
    );
    assert_eq!(
        opened.git_dir().canonicalize().unwrap(),
        sep.canonicalize().unwrap()
    );
}

#[test]
fn worktree_edge_cases_never_open_an_admin_directory() {
    let (tmp, path, _) = fixture();

    // A worktree recorded with a relative gitdir path (git 2.48+ honors the setting;
    // older git writes an absolute path, and the test still applies).
    let wt = tmp.path().join("rel-wt");
    git(
        &path,
        &[
            "-c",
            "worktree.useRelativePaths=true",
            "worktree",
            "add",
            "-q",
            "--detach",
            wt.to_str().unwrap(),
        ],
    );
    match Repo::open(path.join(".git/worktrees/rel-wt")) {
        Err(GitError::NotRepositoryRoot { root, .. }) => {
            assert_eq!(root, wt.canonicalize().unwrap());
        }
        other => panic!("{other:?}"),
    }

    // A deleted worktree: its admin directory is not offered as anything to open.
    let gone = tmp.path().join("gone-wt");
    git(
        &path,
        &["worktree", "add", "-q", "--detach", gone.to_str().unwrap()],
    );
    std::fs::remove_dir_all(&gone).unwrap();
    assert!(matches!(
        Repo::open(path.join(".git/worktrees/gone-wt")),
        Err(GitError::NotARepository(_))
    ));

    // core.worktree = . makes the .git directory its own work tree: refuse both paths.
    let (_tmp2, odd) = new_repo();
    commit_file(&odd, "f", "one");
    git(&odd, &["config", "core.worktree", "."]);
    for p in [odd.clone(), odd.join(".git")] {
        let result = Repo::open(&p);
        assert!(result.is_err(), "{p:?} opened: {result:?}");
    }
}
