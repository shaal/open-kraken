//! Working tree status, stashes, and the files commits changed.
#![cfg(unix)]

mod common;

use std::collections::HashSet;

use common::*;
use git_data::{ChangeKind, FileChange, GitError, Repo};

fn sha_of(repo: &std::path::Path, rev: &str) -> String {
    git(repo, &["rev-parse", rev]).trim().to_owned()
}

fn change(path: &str, kind: ChangeKind) -> FileChange {
    FileChange {
        path: path.into(),
        old_path: None,
        kind,
    }
}

#[test]
fn status_of_the_fixture() {
    let (_tmp, path, _) = fixture();
    let status = Repo::open(&path).unwrap().status().unwrap();
    assert_eq!(status.staged, vec![]);
    assert_eq!(
        status.unstaged,
        vec![
            change("README.md", ChangeKind::Modified),
            change("notes.txt", ChangeKind::Untracked)
        ]
    );
    assert_eq!(status.conflicted, vec![]);
    assert!(!status.is_clean());
}

#[test]
fn status_lists_staged_unstaged_renames_and_odd_names() {
    let (_tmp, path, _) = fixture();
    git(&path, &["mv", "build.sh", "build tool.sh"]);
    std::fs::write(path.join("staged new.txt"), "n").unwrap();
    git(&path, &["add", "staged new.txt"]);
    git(&path, &["rm", "-q", "--cached", "docs.md"]);
    std::fs::remove_file(path.join("api.js")).unwrap();
    std::fs::remove_file(path.join("graph.js")).ok();
    std::fs::create_dir_all(path.join("new dir/deep")).unwrap();
    std::fs::write(path.join("new dir/deep/a.txt"), "a").unwrap();
    std::fs::write(path.join("ünïcode\nname.txt"), "u").unwrap();
    std::fs::remove_file(path.join("CHANGELOG.md")).unwrap();
    std::os::unix::fs::symlink("README.md", path.join("CHANGELOG.md")).unwrap();

    let status = Repo::open(&path).unwrap().status().unwrap();
    assert_eq!(
        status.staged,
        vec![
            FileChange {
                path: "build tool.sh".into(),
                old_path: Some("build.sh".into()),
                kind: ChangeKind::Renamed
            },
            change("docs.md", ChangeKind::Deleted),
            change("staged new.txt", ChangeKind::Added),
        ]
    );
    let unstaged: HashSet<(String, ChangeKind)> = status
        .unstaged
        .iter()
        .map(|c| (c.path.clone(), c.kind))
        .collect();
    let want: HashSet<(String, ChangeKind)> = [
        ("CHANGELOG.md", ChangeKind::TypeChanged),
        ("README.md", ChangeKind::Modified),
        ("api.js", ChangeKind::Deleted),
        ("docs.md", ChangeKind::Untracked),
        ("new dir/deep/a.txt", ChangeKind::Untracked),
        ("notes.txt", ChangeKind::Untracked),
        ("ünïcode\nname.txt", ChangeKind::Untracked),
    ]
    .into_iter()
    .map(|(p, k)| (p.to_owned(), k))
    .collect();
    assert_eq!(unstaged, want);
}

#[test]
fn status_shows_conflicts() {
    let (_tmp, path) = new_repo();
    commit_file(&path, "f.txt", "base");
    git(&path, &["checkout", "-q", "-b", "other"]);
    commit_file(&path, "f.txt", "other side");
    git(&path, &["checkout", "-q", "main"]);
    commit_file(&path, "f.txt", "main side");
    let merge = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["merge", "-q", "other"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(!merge.status.success(), "the merge must conflict");
    let status = Repo::open(&path).unwrap().status().unwrap();
    assert_eq!(
        status.conflicted,
        vec![change("f.txt", ChangeKind::Conflicted)]
    );
    assert_eq!(status.staged, vec![]);
}

#[test]
fn status_ignores_repository_config_and_bare_repos_have_none() {
    let (_tmp, path, origin) = fixture();
    git(&path, &["config", "status.showUntrackedFiles", "no"]);
    git(&path, &["config", "status.renames", "false"]);
    git(&path, &["config", "diff.renames", "false"]);
    git(&path, &["mv", "build.sh", "renamed.sh"]);
    let status = Repo::open(&path).unwrap().status().unwrap();
    assert!(status.unstaged.iter().any(|c| c.path == "notes.txt"));
    assert_eq!(status.staged[0].kind, ChangeKind::Renamed);
    assert!(Repo::open(&origin).unwrap().status().unwrap().is_clean());
}

#[test]
fn stashes_of_the_fixture_and_more() {
    let (_tmp, path, _) = fixture();
    let repo = Repo::open(&path).unwrap();
    let stashes = repo.stashes().unwrap();
    assert_eq!(stashes.len(), 1);
    let s = &stashes[0];
    assert_eq!(
        (s.index, s.selector.as_str(), s.message.as_str()),
        (0, "stash@{0}", "On main: WIP: experiment with caching")
    );
    assert_eq!((s.sha.as_str(), s.base_sha.as_str()), (STASH, MAIN));
    assert_eq!(s.time, 1_759_300_000 + 20 * 7200);

    // Two more, one with untracked files (a stash commit with 3 parents).
    git(&path, &["stash", "-q", "-u", "-m", "with untracked"]);
    std::fs::write(path.join("api.js"), "changed").unwrap();
    git(&path, &["stash", "-q", "-m", "second"]);
    let stashes = repo.stashes().unwrap();
    let messages: Vec<&str> = stashes.iter().map(|s| s.message.as_str()).collect();
    assert_eq!(
        messages,
        [
            "On main: second",
            "On main: with untracked",
            "On main: WIP: experiment with caching"
        ]
    );
    for (i, s) in stashes.iter().enumerate() {
        assert_eq!(s.index, i);
        assert_eq!(s.selector, format!("stash@{{{i}}}"));
        assert_eq!(s.base_sha, MAIN);
        assert_eq!(s.sha, sha_of(&path, &format!("stash@{{{i}}}")));
    }
    let (_t2, empty) = new_repo();
    assert_eq!(Repo::open(&empty).unwrap().stashes().unwrap(), vec![]);
}

#[test]
fn log_includes_the_commit_a_stash_was_made_on() {
    let (_tmp, path, _) = fixture();
    git(&path, &["stash", "-q", "-u"]);
    git(&path, &["checkout", "-q", "--detach", "v1.0"]);
    let base = commit_file(&path, "detached.txt", "Only a stash remembers this");
    std::fs::write(path.join("detached.txt"), "edited").unwrap();
    git(&path, &["stash", "-q"]);
    git(&path, &["checkout", "-q", "main"]);

    let repo = Repo::open(&path).unwrap();
    let log = repo.log().unwrap();
    let shas: HashSet<&str> = log.iter().map(|c| c.sha.as_str()).collect();
    assert!(shas.contains(base.as_str()), "stash base is in the graph");
    for s in repo.stashes().unwrap() {
        assert!(!shas.contains(s.sha.as_str()), "stash commits are not");
    }
    assert_eq!(log.len(), 20);
}

#[test]
fn files_of_single_commits() {
    let (_tmp, path, _) = fixture();
    let repo = Repo::open(&path).unwrap();
    let files = |rev: &str| repo.commit_files(&sha_of(&path, rev)).unwrap();
    assert_eq!(
        files(":/Add context menu on commits"),
        vec![change("graph.js", ChangeKind::Modified)]
    );
    assert_eq!(
        files(":/Initial commit"),
        vec![change("README.md", ChangeKind::Added)],
        "a root commit is compared with an empty tree"
    );
    assert_eq!(
        files(":/Merge branch 'feature/login'"),
        vec![change("login.js", ChangeKind::Added)],
        "a merge is compared with its first parent"
    );

    git(&path, &["stash", "-q", "-u"]);
    git(&path, &["mv", "build.sh", "scripts-build.sh"]);
    git(&path, &["commit", "-q", "-m", "rename"]);
    assert_eq!(
        files("HEAD"),
        vec![FileChange {
            path: "scripts-build.sh".into(),
            old_path: Some("build.sh".into()),
            kind: ChangeKind::Renamed
        }]
    );
}

/// The file lists GitKraken showed for these selections (docs/graph-behavior-spec.md §4).
#[test]
fn files_of_multi_selections_match_the_observed_behavior() {
    let (_tmp, path, _) = fixture();
    let repo = Repo::open(&path).unwrap();
    let sha = |message: &str| sha_of(&path, &format!(":/{message}"));
    let range = |messages: &[&str]| {
        let shas: Vec<String> = messages.iter().map(|m| sha(m)).collect();
        let refs: Vec<&str> = shas.iter().map(String::as_str).collect();
        let forward = repo.range_files(&refs).unwrap();
        let reversed: Vec<&str> = refs.iter().rev().copied().collect();
        assert_eq!(
            forward,
            repo.range_files(&reversed).unwrap(),
            "order does not matter"
        );
        forward
    };

    // Shift+click range of 3 on feature/graph-view: "Viewing diff of 3 commits", 1 added.
    assert_eq!(
        range(&[
            "Scaffold graph view",
            "Draw commit lanes",
            "Add context menu on commits"
        ]),
        vec![change("graph.js", ChangeKind::Added)]
    );
    // Cmd+click of 2 unrelated commits: "Viewing diff between 2 commits", 1 added, 1 deleted.
    assert_eq!(
        range(&["Fix typo in docs", "Add login form"]),
        vec![
            change("docs.md", ChangeKind::Added),
            change("login.js", ChangeKind::Deleted)
        ]
    );
    // HEAD and its parent: "Viewing diff between 2 commits", 1 modified.
    assert_eq!(
        range(&["Update roadmap", "Add metrics endpoint"]),
        vec![change("README.md", ChangeKind::Modified)]
    );
    // One commit is the same as commit_files.
    let one = sha("Add login form");
    assert_eq!(
        repo.range_files(&[&one]).unwrap(),
        repo.commit_files(&one).unwrap()
    );
}

#[test]
fn commit_ids_from_the_ui_are_validated() {
    let (_tmp, path, _) = fixture();
    let repo = Repo::open(&path).unwrap();
    for bad in ["HEAD", "--output=/tmp/x", "main", "35883939"] {
        assert!(
            matches!(repo.commit_files(bad), Err(GitError::InvalidArgument(_))),
            "{bad}"
        );
        assert!(matches!(
            repo.range_files(&[MAIN, bad]),
            Err(GitError::InvalidArgument(_))
        ));
    }
    let missing = "0123456789abcdef0123456789abcdef01234567";
    assert!(matches!(
        repo.commit_files(missing),
        Err(GitError::CommandFailed { .. })
    ));
}

/// Runs git with fixed author and committer dates.
fn commit_at(repo: &std::path::Path, file: &str, message: &str, date: &str) -> String {
    std::fs::write(repo.join(file), message).unwrap();
    git(repo, &["add", file]);
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["commit", "-q", "-m", message])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .unwrap();
    assert!(out.status.success());
    sha_of(repo, "HEAD")
}

#[test]
fn range_with_a_root_commit_and_a_merge() {
    let (_tmp, path) = new_repo();
    let root = commit_file(&path, "r.txt", "root");
    git(&path, &["checkout", "-q", "-b", "side"]);
    commit_file(&path, "s.txt", "side");
    git(&path, &["checkout", "-q", "main"]);
    let m1 = commit_file(&path, "m.txt", "main");
    git(
        &path,
        &["merge", "-q", "--no-ff", "side", "-m", "merge side"],
    );
    let merge = sha_of(&path, "HEAD");
    let files = Repo::open(&path)
        .unwrap()
        .range_files(&[&root, &m1, &merge])
        .unwrap();
    let paths: HashSet<&str> = files.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, HashSet::from(["r.txt", "m.txt", "s.txt"]));
    assert!(files.iter().all(|c| c.kind == ChangeKind::Added));
}

#[test]
fn range_follows_ancestry_not_dates() {
    // Same date for parent and child, and a child dated before its parent.
    let (_tmp, path) = new_repo();
    let a = commit_at(&path, "a.txt", "a", "@1700000000 +0000");
    let b = commit_at(&path, "b.txt", "b", "@1700000000 +0000");
    let c = commit_at(&path, "c.txt", "c", "@1600000000 +0000");
    let d = commit_at(&path, "d.txt", "d", "@1500000000 +0000");
    let repo = Repo::open(&path).unwrap();
    for pair in [[a.as_str(), b.as_str()], [b.as_str(), a.as_str()]] {
        assert_eq!(
            repo.range_files(&pair).unwrap(),
            vec![change("b.txt", ChangeKind::Added)]
        );
    }
    for pair in [[b.as_str(), c.as_str()], [c.as_str(), b.as_str()]] {
        assert_eq!(
            repo.range_files(&pair).unwrap(),
            vec![change("c.txt", ChangeKind::Added)],
            "the child is newer even with an older date"
        );
    }
    let files = repo.range_files(&[&d, &b, &c, &b]).unwrap();
    let paths: Vec<&str> = files.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(
        paths,
        ["b.txt", "c.txt", "d.txt"],
        "oldest is b; duplicates ignored"
    );
}

#[test]
fn status_reports_submodules_even_when_configured_to_hide_them() {
    let (tmp, path) = new_repo();
    let sub_src = tmp.path().join("sub-src");
    std::fs::create_dir(&sub_src).unwrap();
    git(&sub_src, &["init", "-q", "-b", "main"]);
    commit_file(&sub_src, "s.txt", "one");
    commit_file(&path, "top.txt", "top");
    let url = format!("file://{}", sub_src.display());
    git(
        &path,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &url,
            "sub",
        ],
    );
    git(
        &path,
        &["config", "-f", ".gitmodules", "submodule.sub.ignore", "all"],
    );
    git(&path, &["add", ".gitmodules"]);
    git(&path, &["commit", "-q", "-m", "add submodule"]);
    git(&path, &["config", "diff.ignoreSubmodules", "all"]);
    commit_file(&path.join("sub"), "s.txt", "new commit inside");
    let status = Repo::open(&path).unwrap().status().unwrap();
    assert_eq!(status.unstaged, vec![change("sub", ChangeKind::Modified)]);
}

#[test]
fn range_edges_empty_selection_and_unrelated_histories() {
    let (_tmp, path) = new_repo();
    let a = commit_file(&path, "a.txt", "a");
    git(&path, &["checkout", "-q", "--orphan", "island"]);
    git(&path, &["rm", "-q", "-r", "--cached", "."]);
    std::fs::remove_file(path.join("a.txt")).unwrap();
    let z = commit_file(&path, "z.txt", "z");
    let repo = Repo::open(&path).unwrap();
    assert!(matches!(
        repo.range_files(&[]),
        Err(GitError::InvalidArgument(_))
    ));
    // No common ancestor: the walk is not bounded, and the order still holds.
    let files = repo.range_files(&[&a, &z]).unwrap();
    assert_eq!(files.len(), 2, "{files:?}");
    let reversed = repo.range_files(&[&z, &a]).unwrap();
    assert_eq!(files, reversed);
}

/// Spec §2/§4: the 9-commit Shift+click range shows 4 added files and 1 modified.
#[test]
fn nine_commit_shift_click_range_matches_the_observed_file_list() {
    let (_tmp, path, _) = fixture();
    let repo = Repo::open(&path).unwrap();
    let validate = sha_of(&path, ":/Validate email field");
    let range = git(
        &path,
        &["rev-list", "main", "--not", &format!("{validate}^@")],
    );
    let shas: Vec<&str> = range.lines().collect();
    assert_eq!(shas.len(), 9);
    let files = repo.range_files(&shas).unwrap();
    let mut summary: Vec<String> = files
        .iter()
        .map(|f| format!("{:?} {}", f.kind, f.path))
        .collect();
    summary.sort();
    assert_eq!(
        summary,
        [
            "Added CHANGELOG.md",
            "Added api.js",
            "Added docs.md",
            "Added login.js",
            "Modified README.md"
        ]
    );
}

/// Writes a filter program that leaves a marker file when it runs.
fn marker_filter(dir: &std::path::Path) -> (std::path::PathBuf, String) {
    let marker = dir.join("filter-ran");
    let script = dir.join("filter.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    (marker, script.display().to_string())
}

#[test]
fn a_repository_defining_its_own_filters_is_not_status_read() {
    let (tmp, path, _) = fixture();
    let (marker, script) = marker_filter(tmp.path());
    git(&path, &["config", "filter.evil.clean", &script]);
    std::fs::write(path.join(".gitattributes"), "* filter=evil\n").unwrap();
    std::fs::write(path.join("docs.md"), "touched").unwrap();
    let graph = Repo::open(&path).unwrap().graph_data().unwrap();
    assert!(!marker.exists(), "the repository's filter ran");
    let reason = graph.status.skipped.clone().expect("status skipped");
    assert!(reason.contains("evil"), "{reason}");
    assert!(graph.status.is_clean());
    assert_eq!(graph.log.len(), 19, "history is still read");
}

#[test]
fn submodule_work_trees_are_not_read() {
    let (tmp, path) = new_repo();
    let sub_src = tmp.path().join("sub-src");
    std::fs::create_dir(&sub_src).unwrap();
    git(&sub_src, &["init", "-q", "-b", "main"]);
    commit_file(&sub_src, "s.txt", "one");
    commit_file(&path, "top.txt", "top");
    let url = format!("file://{}", sub_src.display());
    git(
        &path,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &url,
            "sub",
        ],
    );
    git(&path, &["commit", "-q", "-m", "add submodule"]);
    let sub = path.join("sub");
    let (marker, script) = marker_filter(tmp.path());
    git(&sub, &["config", "filter.evil.clean", &script]);
    std::fs::write(sub.join(".gitattributes"), "* filter=evil\n").unwrap();
    std::fs::write(sub.join("s.txt"), "edited inside the submodule").unwrap();
    let status = Repo::open(&path).unwrap().status().unwrap();
    assert!(!marker.exists(), "a filter inside the submodule ran");
    assert_eq!(status.skipped, None);
    assert!(
        status.is_clean(),
        "uncommitted edits inside a submodule are not read"
    );
}
