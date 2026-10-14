//! Everything the graph view needs in one call, and the fixture file format.

use std::collections::BTreeMap;

use serde::Serialize;
use ts_rs::TS;

use crate::changes::{FileChange, WorkingTreeStatus};
use crate::error::GitError;
use crate::log::Commit;
use crate::refs::RepoRefs;
use crate::repo::Repo;
use crate::stash::Stash;

/// Where a repository is and what it is called.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoInfo {
    /// The path to pass back to later calls: the work tree root, or the bare
    /// repository directory. A path that is not valid UTF-8 cannot round-trip:
    /// its invalid bytes become U+FFFD, so such a repository cannot be reopened.
    pub root: String,
    pub git_dir: String,
    pub bare: bool,
    /// The folder name, for tabs and titles.
    pub name: String,
}

/// The history, refs, working tree and stashes, read together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphData {
    pub log: Vec<Commit>,
    pub refs: RepoRefs,
    pub status: WorkingTreeStatus,
    pub stashes: Vec<Stash>,
}

/// The browser fixture (`fixtures/demo-repo.json`), written by the `dump` tool:
/// the graph data of a repository plus precomputed file lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Fixture {
    pub info: RepoInfo,
    pub graph: GraphData,
    /// `commit_files` for every commit in the log, by sha.
    pub commit_files: BTreeMap<String, Vec<FileChange>>,
    /// `range_files` for chosen selections, keyed by the sorted shas joined with ",".
    pub range_files: BTreeMap<String, Vec<FileChange>>,
}

impl Repo {
    /// Where this repository is and what it is called.
    pub fn info(&self) -> RepoInfo {
        let root = self.work_dir().unwrap_or(self.git_dir());
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned());
        RepoInfo {
            root: root.to_string_lossy().into_owned(),
            git_dir: self.git_dir().to_string_lossy().into_owned(),
            bare: self.work_dir().is_none(),
            name,
        }
    }

    /// The history, refs, working tree and stashes. Refs and stashes are read
    /// before the log, so the commits they point at are normally in the log. The
    /// reads are not one atomic snapshot: if a ref is deleted or rewritten while
    /// this runs, a ref can point at a commit missing from the log. Consumers must
    /// tolerate that (skip the label).
    pub fn graph_data(&self) -> Result<GraphData, GitError> {
        let refs = self.refs()?;
        let stashes = self.stashes()?;
        let status = self.status()?;
        let log = self.log_with_stashes(&stashes)?;
        Ok(GraphData {
            log,
            refs,
            status,
            stashes,
        })
    }
}

/// The key `Fixture::range_files` uses for a selection.
pub fn range_key(shas: &[&str]) -> String {
    let mut sorted: Vec<&str> = shas.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    sorted.join(",")
}
