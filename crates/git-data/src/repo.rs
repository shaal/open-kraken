//! Opening a repository and running git in it.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::GitError;

/// Environment variables that would make git act on another repository or
/// namespace than the one we pass with `-C`.
const REPO_ENV_VARS: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
];

/// An open git repository (a work tree or a bare repository).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    git_dir: PathBuf,
    work_dir: Option<PathBuf>,
}

impl Repo {
    /// Opens the repository whose root is `path`: the work tree root of a
    /// repository, or a bare repository directory. A directory inside a
    /// repository (a subfolder, or its `.git` directory) gives
    /// [`GitError::NotRepositoryRoot`] with the root to open instead, so a folder
    /// inside, say, a home-directory dotfiles repo is never opened by accident.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GitError> {
        let path = path.as_ref();
        if !path.is_dir() {
            // The `.git` file of a linked worktree or submodule: open its folder.
            if path.is_file()
                && path.file_name() == Some(".git".as_ref())
                && let Some(root) = path.parent().filter(|p| !p.as_os_str().is_empty())
            {
                return Err(GitError::NotRepositoryRoot {
                    path: path.to_path_buf(),
                    root: root.to_path_buf(),
                });
            }
            return Err(GitError::PathNotFound(path.to_path_buf()));
        }
        // One value per call: paths may contain newlines, so only the final one is stripped.
        let bare_args = ["rev-parse", "--is-bare-repository"];
        let bare = match run_in(path, &bare_args) {
            Err(GitError::CommandFailed { stderr, .. })
                if stderr.contains("not a git repository") =>
            {
                return Err(GitError::NotARepository(path.to_path_buf()));
            }
            other => other?,
        };
        let bare = match last_line(&bare) {
            b"true" => true,
            b"false" => false,
            other => {
                let detail = format!(
                    "expected true or false, got {:?}",
                    String::from_utf8_lossy(other)
                );
                return Err(unexpected(&bare_args, detail));
            }
        };
        let dir_args = ["rev-parse", "--absolute-git-dir"];
        let git_dir = path_from_bytes(last_line(&run_in(path, &dir_args)?))
            .ok_or_else(|| unexpected(&dir_args, "git dir is not a valid path"))?;

        let root = if bare {
            git_dir.clone()
        } else {
            let top_args = ["rev-parse", "--show-toplevel"];
            match run_in(path, &top_args) {
                Ok(out) => path_from_bytes(last_line(&out))
                    .ok_or_else(|| unexpected(&top_args, "work tree is not a valid path"))?,
                // Inside the git directory of a repository that has a work tree:
                // never open it; point at the work tree when it can be found.
                Err(GitError::CommandFailed { .. }) => match work_tree_of(&git_dir) {
                    Some(root) => {
                        return Err(GitError::NotRepositoryRoot {
                            path: path.to_path_buf(),
                            root,
                        });
                    }
                    None => return Err(GitError::NotARepository(path.to_path_buf())),
                },
                Err(err) => return Err(err),
            }
        };
        let same = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        // A work tree configured inside its own git directory (`core.worktree = .`)
        // would make git admin files look like project files.
        if !bare
            && let (Ok(top), Ok(dir)) = (root.canonicalize(), git_dir.canonicalize())
            && top.starts_with(&dir)
        {
            return Err(unexpected(
                &["rev-parse", "--show-toplevel"],
                "the work tree is inside the git directory",
            ));
        }
        if !same(path, &root) {
            return Err(GitError::NotRepositoryRoot {
                path: path.to_path_buf(),
                root,
            });
        }
        let work_dir = (!bare).then_some(root);
        Ok(Self { git_dir, work_dir })
    }

    /// The `.git` directory (or the bare repository directory).
    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    /// The work tree root, or `None` for a bare repository.
    pub fn work_dir(&self) -> Option<&Path> {
        self.work_dir.as_deref()
    }

    /// Runs git in this repository and returns its standard output.
    pub(crate) fn run(&self, args: &[&str]) -> Result<Vec<u8>, GitError> {
        run_in(self.work_dir().unwrap_or(&self.git_dir), args)
    }

    /// Like [`Repo::run`], but returns `None` when git exits with code 1, as
    /// `git symbolic-ref -q` and `git rev-parse -q --verify` do for "not found".
    pub(crate) fn run_optional(&self, args: &[&str]) -> Result<Option<Vec<u8>>, GitError> {
        match self.run(args) {
            Ok(out) => Ok(Some(out)),
            Err(GitError::CommandFailed { code: Some(1), .. }) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

/// Runs `git -C <dir> <args>` with a stable configuration and environment.
fn run_in(dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args([
            "-c",
            "color.ui=false",
            "-c",
            "log.showSignature=false",
            "-c",
            "i18n.logOutputEncoding=UTF-8",
        ])
        .args(args)
        // English messages (we match on "not a git repository"), no prompts, and no
        // index refresh locks taken by read-only commands.
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    for var in REPO_ENV_VARS {
        cmd.env_remove(var);
    }
    let output = cmd.output().map_err(GitError::GitNotStarted)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed {
            command: args.join(" "),
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(output.stdout)
}

pub(crate) fn unexpected(args: &[&str], detail: impl Into<String>) -> GitError {
    GitError::UnexpectedOutput {
        command: args.join(" "),
        detail: detail.into(),
    }
}

/// The work tree of a non-bare git directory: the parent of a `.git` directory,
/// or, for a linked worktree's admin directory, the folder its `gitdir` file names
/// (git may write that path relative to the admin directory). `None` when the
/// folder does not exist (for example a deleted worktree).
fn work_tree_of(git_dir: &Path) -> Option<PathBuf> {
    let root = if git_dir.file_name() == Some(".git".as_ref()) {
        git_dir.parent()?.to_path_buf()
    } else {
        let gitdir_file = std::fs::read(git_dir.join("gitdir")).ok()?;
        let dot_git = path_from_bytes(last_line(&gitdir_file))?;
        git_dir.join(dot_git).parent()?.to_path_buf()
    };
    let root = root.canonicalize().ok()?;
    root.is_dir().then_some(root)
}

/// The output without its single trailing newline.
fn last_line(out: &[u8]) -> &[u8] {
    out.strip_suffix(b"\n").unwrap_or(out)
}

/// Git prints paths as raw bytes; keep them exact on Unix, require UTF-8 elsewhere.
fn path_from_bytes(bytes: &[u8]) -> Option<PathBuf> {
    if bytes.is_empty() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
    }
    #[cfg(not(unix))]
    {
        std::str::from_utf8(bytes).ok().map(PathBuf::from)
    }
}
