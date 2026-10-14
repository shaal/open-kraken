//! Git access for open-kraken through the `git` command-line tool.
//!
//! This crate has no Tauri dependency, so `cargo test -p git-data` runs anywhere
//! git is installed (including CI runners without webkit).
//!
//! Open a repository with [`Repo::open`], then read its history with [`Repo::log`]
//! and its branches, tags and HEAD with [`Repo::refs`].

mod error;
mod log;
mod refs;
mod repo;
mod version;

pub use error::GitError;
pub use log::Commit;
pub use refs::{Head, Ref, RefKind, RepoRefs};
pub use repo::Repo;
pub use version::{
    GitVersion, GitVersionError, MIN_GIT_VERSION, installed_git_version, parse_git_version,
};
