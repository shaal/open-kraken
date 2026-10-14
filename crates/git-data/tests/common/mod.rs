//! Helpers shared by the integration tests.
#![allow(dead_code)] // each test binary uses a different subset

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

pub const MAIN: &str = "35883939c0918f6444fc665a61ab7484048769c3";
pub const ORIGIN_MAIN: &str = "7b0c8b331f8f48d0389c4c194643bd1773956bbd";
pub const STASH: &str = "ece8df0b818b6a851e8c5b1c454c4f1ca7c82c01";

/// Runs git in `dir` with no user config and a fixed identity; panics on failure.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Tester")
        .env("GIT_AUTHOR_EMAIL", "tester@example.com")
        .env("GIT_COMMITTER_NAME", "Tester")
        .env("GIT_COMMITTER_EMAIL", "tester@example.com")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Builds the demo fixture in a new temp dir; returns (temp dir, repo, origin).
pub fn fixture_in(subdir: &str) -> (TempDir, PathBuf, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let parent = tmp.path().join(subdir);
    std::fs::create_dir_all(&parent).unwrap();
    let (repo, origin) = (parent.join("repo"), parent.join("origin.git"));
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/fixtures/make-demo-repo.sh");
    let out = Command::new("bash")
        .arg(script)
        .arg(&repo)
        .arg(&origin)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "fixture: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    (tmp, repo, origin)
}

pub fn fixture() -> (TempDir, PathBuf, PathBuf) {
    fixture_in("f")
}

pub fn new_repo() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let repo = tmp.path().join("r");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    (tmp, repo)
}

pub fn commit_file(repo: &Path, name: &str, message: &str) -> String {
    std::fs::write(repo.join(name), message).unwrap();
    git(repo, &["add", name]);
    git(repo, &["commit", "-q", "-m", message]);
    git(repo, &["rev-parse", "HEAD"]).trim().to_owned()
}
