//! Errors from reading a repository.

use std::fmt;
use std::path::PathBuf;

use serde::Serialize;
use ts_rs::TS;

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

/// What kind of error happened, for the UI to switch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ErrorKind {
    GitNotStarted,
    PathNotFound,
    NotARepository,
    NotRepositoryRoot,
    InvalidArgument,
    CommandFailed,
    UnexpectedOutput,
    /// A failure outside git (for example a crashed background task).
    Internal,
}

/// An error as the UI receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ErrorInfo {
    pub kind: ErrorKind,
    /// A sentence for people.
    pub message: String,
    /// The path the error is about, when there is one.
    pub path: Option<String>,
    /// For `notRepositoryRoot`: the repository root to open instead.
    pub root: Option<String>,
}

impl ErrorInfo {
    /// An error that did not come from git.
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Internal,
            message: message.into(),
            path: None,
            root: None,
        }
    }
}

impl GitError {
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::GitNotStarted(_) => ErrorKind::GitNotStarted,
            Self::PathNotFound(_) => ErrorKind::PathNotFound,
            Self::NotARepository(_) => ErrorKind::NotARepository,
            Self::NotRepositoryRoot { .. } => ErrorKind::NotRepositoryRoot,
            Self::InvalidArgument(_) => ErrorKind::InvalidArgument,
            Self::CommandFailed { .. } => ErrorKind::CommandFailed,
            Self::UnexpectedOutput { .. } => ErrorKind::UnexpectedOutput,
        }
    }
}

impl From<&GitError> for ErrorInfo {
    fn from(err: &GitError) -> Self {
        let display = |p: &std::path::Path| Some(p.to_string_lossy().into_owned());
        let (path, root) = match err {
            GitError::PathNotFound(p) | GitError::NotARepository(p) => (display(p), None),
            GitError::NotRepositoryRoot { path, root } => (display(path), display(root)),
            _ => (None, None),
        };
        Self {
            kind: err.kind(),
            message: err.to_string(),
            path,
            root,
        }
    }
}

impl From<GitError> for ErrorInfo {
    fn from(err: GitError) -> Self {
        Self::from(&err)
    }
}
