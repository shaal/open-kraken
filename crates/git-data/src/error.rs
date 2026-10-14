//! Errors from reading a repository.

use std::fmt;
use std::path::PathBuf;

/// Why a repository could not be read.
#[derive(Debug)]
pub enum GitError {
    /// The `git` executable could not be started.
    GitNotStarted(std::io::Error),
    /// The path does not exist or is not a directory.
    PathNotFound(PathBuf),
    /// The path is not inside a git repository.
    NotARepository(PathBuf),
    /// The path is inside a repository but is not its root; open `root` instead.
    NotRepositoryRoot { path: PathBuf, root: PathBuf },
    /// A value passed in (for example a commit id) is not valid.
    InvalidArgument(String),
    /// A git command exited with an error.
    CommandFailed {
        /// The git arguments, for example `log --date-order ...`.
        command: String,
        /// Exit code, or `None` when a signal ended the process.
        code: Option<i32>,
        stderr: String,
    },
    /// Git's output did not have the expected shape.
    UnexpectedOutput { command: String, detail: String },
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GitNotStarted(err) => write!(f, "git could not be started: {err}"),
            Self::PathNotFound(path) => write!(f, "{} is not a directory", path.display()),
            Self::NotARepository(path) => {
                write!(f, "{} is not inside a git repository", path.display())
            }
            Self::NotRepositoryRoot { path, root } => write!(
                f,
                "{} is inside the repository at {}; open that folder instead",
                path.display(),
                root.display()
            ),
            Self::InvalidArgument(detail) => write!(f, "invalid argument: {detail}"),
            Self::CommandFailed {
                command,
                code,
                stderr,
            } => {
                let code = code.map_or_else(|| "a signal".to_owned(), |c| format!("code {c}"));
                write!(f, "`git {command}` failed with {code}: {}", stderr.trim())
            }
            Self::UnexpectedOutput { command, detail } => {
                write!(f, "unexpected output from `git {command}`: {detail}")
            }
        }
    }
}

impl std::error::Error for GitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::GitNotStarted(err) => Some(err),
            _ => None,
        }
    }
}
