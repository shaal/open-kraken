//! Git access for open-kraken through the `git` command-line tool.
//!
//! This crate has no Tauri dependency, so `cargo test -p git-data` runs anywhere
//! git is installed (including CI runners without webkit).
//!
//! Open a repository with [`Repo::open`], then read its history with [`Repo::log`],
//! its branches, tags and HEAD with [`Repo::refs`], uncommitted changes with
//! [`Repo::status`], stashes with [`Repo::stashes`], and the files commits changed
//! with [`Repo::commit_files`] and [`Repo::range_files`].

mod changes;
mod error;
mod graph;
mod log;
mod refs;
mod repo;
mod stash;
mod version;

pub use changes::{ChangeKind, FileChange, WorkingTreeStatus};
pub use error::{ErrorInfo, ErrorKind, GitError};
pub use graph::{Fixture, GraphData, RepoInfo, range_key};
pub use log::Commit;
pub use refs::{Head, Ref, RefKind, RepoRefs};
pub use repo::Repo;
pub use stash::Stash;
pub use version::{
    GitVersion, GitVersionError, MIN_GIT_VERSION, installed_git_version, parse_git_version,
};
