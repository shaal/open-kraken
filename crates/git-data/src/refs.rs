//! Reading branches, tags and HEAD.

use serde::Serialize;

use crate::error::GitError;
use crate::log::object_id;
use crate::repo::{Repo, unexpected};

/// What a ref is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}

/// A branch or tag that points at a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    /// Full name, for example `refs/remotes/origin/main`.
    pub name: String,
    /// Name without the `refs/heads/`, `refs/remotes/` or `refs/tags/` prefix,
    /// for example `origin/main`.
    pub short_name: String,
    pub kind: RefKind,
    /// The remote of a remote branch, for example `origin`.
    pub remote: Option<String>,
    /// The commit the ref points at (annotated tags are peeled to their commit).
    pub sha: String,
    /// True for an annotated tag.
    pub annotated: bool,
    /// The upstream of a local branch, as a full ref name.
    pub upstream: Option<String>,
}

/// Where HEAD points.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum Head {
    /// HEAD is a branch: full ref name (`refs/heads/main`) and short name
    /// (`main`). `sha` is `None` before the first commit on that branch.
    Branch {
        name: String,
        short_name: String,
        sha: Option<String>,
    },
    /// HEAD points directly at a commit.
    Detached { sha: String },
}

/// All branches and tags, and HEAD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRefs {
    pub head: Head,
    /// Sorted by full name. Symbolic refs (such as `refs/remotes/origin/HEAD`) and
    /// tags that do not point at a commit are left out.
    pub refs: Vec<Ref>,
}

/// One ref per line (ref names cannot contain newlines); fields separated by NUL.
const REF_FORMAT: &str = "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(upstream)%00%(symref)";

impl Repo {
    /// Local branches, remote branches, tags and HEAD.
    pub fn refs(&self) -> Result<RepoRefs, GitError> {
        let args = [
            "for-each-ref",
            REF_FORMAT,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ];
        let out = self.run(&args)?;
        let remotes = self.remote_names()?;
        let refs = parse_refs(&out, &remotes).map_err(|detail| unexpected(&args, detail))?;
        Ok(RepoRefs {
            head: self.head()?,
            refs,
        })
    }

    /// Where HEAD points.
    pub fn head(&self) -> Result<Head, GitError> {
        let sha = self.head_commit()?;
        let args = ["symbolic-ref", "-q", "HEAD"];
        match self.run_optional(&args)? {
            Some(out) => {
                let name =
                    String::from_utf8_lossy(out.strip_suffix(b"\n").unwrap_or(&out)).into_owned();
                let short_name = ["refs/heads/", "refs/remotes/", "refs/tags/"]
                    .iter()
                    .find_map(|prefix| name.strip_prefix(prefix))
                    .unwrap_or(&name)
                    .to_owned();
                Ok(Head::Branch {
                    name,
                    short_name,
                    sha,
                })
            }
            None => {
                let sha =
                    sha.ok_or_else(|| unexpected(&args, "HEAD is neither a branch nor a commit"))?;
                Ok(Head::Detached { sha })
            }
        }
    }

    /// The commit HEAD points at, or `None` before the first commit.
    pub(crate) fn head_commit(&self) -> Result<Option<String>, GitError> {
        let args = ["rev-parse", "-q", "--verify", "HEAD^{commit}"];
        match self.run_optional(&args)? {
            Some(out) => object_id(out.strip_suffix(b"\n").unwrap_or(&out))
                .map(Some)
                .map_err(|detail| unexpected(&args, detail)),
            None => Ok(None),
        }
    }

    fn remote_names(&self) -> Result<Vec<String>, GitError> {
        let out = self.run(&["remote"])?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }
}

/// Parses `git for-each-ref` output written with [`REF_FORMAT`].
pub(crate) fn parse_refs(out: &[u8], remotes: &[String]) -> Result<Vec<Ref>, String> {
    let mut refs = Vec::new();
    for line in out.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let fields: Vec<&[u8]> = line.split(|b| *b == 0).collect();
        let [name, kind, id, peeled_kind, peeled_id, upstream, symref] = fields[..] else {
            return Err(format!("expected 7 fields, got {}", fields.len()));
        };
        if !symref.is_empty() {
            continue; // refs/remotes/origin/HEAD and other aliases
        }
        let (sha, annotated) = match (kind, peeled_kind) {
            (b"commit", _) => (object_id(id)?, false),
            (b"tag", b"commit") => (object_id(peeled_id)?, true),
            _ => continue, // tags of trees or blobs: not part of the graph
        };
        let name = String::from_utf8_lossy(name).into_owned();
        let (kind, short_name, remote) = if let Some(short) = name.strip_prefix("refs/heads/") {
            (RefKind::LocalBranch, short.to_owned(), None)
        } else if let Some(short) = name.strip_prefix("refs/remotes/") {
            let remote = remote_of(short, remotes);
            (RefKind::RemoteBranch, short.to_owned(), Some(remote))
        } else if let Some(short) = name.strip_prefix("refs/tags/") {
            (RefKind::Tag, short.to_owned(), None)
        } else {
            return Err(format!("unexpected ref {name:?}"));
        };
        let upstream = (kind == RefKind::LocalBranch && !upstream.is_empty())
            .then(|| String::from_utf8_lossy(upstream).into_owned());
        refs.push(Ref {
            name,
            short_name,
            kind,
            remote,
            sha,
            annotated,
            upstream,
        });
    }
    Ok(refs)
}

/// The remote of `origin/feature/x`: the longest configured remote name that
/// prefixes it, or the first path component when no configured remote matches.
fn remote_of(short: &str, remotes: &[String]) -> String {
    remotes
        .iter()
        .filter(|remote| {
            short
                .strip_prefix(remote.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
        })
        .max_by_key(|remote| remote.len())
        .cloned()
        .unwrap_or_else(|| short.split('/').next().unwrap_or(short).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";
    const T: &str = "9999999999999999999999999999999999999999";

    fn line(fields: [&str; 7]) -> String {
        fields.join("\0") + "\n"
    }

    fn remotes(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn parses_branches_remotes_and_tags() {
        let out = [
            line([
                "refs/heads/feature/x",
                "commit",
                A,
                "",
                "",
                "refs/remotes/origin/feature/x",
                "",
            ]),
            line(["refs/heads/main", "commit", B, "", "", "", ""]),
            line([
                "refs/remotes/origin/HEAD",
                "commit",
                B,
                "",
                "",
                "",
                "refs/remotes/origin/main",
            ]),
            line(["refs/remotes/origin/feature/x", "commit", A, "", "", "", ""]),
            line(["refs/tags/v1", "commit", A, "", "", "", ""]),
            line(["refs/tags/v2", "tag", T, "commit", B, "", ""]),
        ]
        .concat();
        let refs = parse_refs(out.as_bytes(), &remotes(&["origin"])).unwrap();
        assert_eq!(refs.len(), 5, "origin/HEAD is a symref and is skipped");
        assert_eq!(refs[0].kind, RefKind::LocalBranch);
        assert_eq!(refs[0].short_name, "feature/x");
        assert_eq!(
            refs[0].upstream.as_deref(),
            Some("refs/remotes/origin/feature/x")
        );
        assert_eq!(refs[1].upstream, None);
        assert_eq!(refs[2].kind, RefKind::RemoteBranch);
        assert_eq!(refs[2].short_name, "origin/feature/x");
        assert_eq!(refs[2].remote.as_deref(), Some("origin"));
        assert_eq!(refs[3].kind, RefKind::Tag);
        assert!(!refs[3].annotated);
        assert_eq!(refs[4].sha, B, "annotated tag peeled to its commit");
        assert!(refs[4].annotated);
    }

    #[test]
    fn skips_tags_of_trees_and_blobs() {
        let out = [
            line(["refs/tags/tree", "tree", T, "", "", "", ""]),
            line(["refs/tags/blob-tag", "tag", T, "blob", A, "", ""]),
        ]
        .concat();
        assert_eq!(parse_refs(out.as_bytes(), &[]).unwrap(), Vec::new());
    }

    #[test]
    fn picks_the_longest_matching_remote() {
        let names = remotes(&["up", "up/stream", "origin"]);
        assert_eq!(remote_of("up/stream/main", &names), "up/stream");
        assert_eq!(remote_of("up/main", &names), "up");
        assert_eq!(remote_of("origin/a/b", &names), "origin");
        assert_eq!(
            remote_of("gone/main", &names),
            "gone",
            "unconfigured remote"
        );
        assert_eq!(
            remote_of("upx/main", &names),
            "upx",
            "prefix must end at a slash"
        );
    }

    #[test]
    fn rejects_malformed_lines() {
        assert!(parse_refs(b"refs/heads/main\0commit\n", &[]).is_err());
        let bad_id = line(["refs/heads/main", "commit", "xyz", "", "", "", ""]);
        assert!(parse_refs(bad_id.as_bytes(), &[]).is_err());
        let odd_ref = line(["refs/notes/x", "commit", A, "", "", "", ""]);
        assert!(parse_refs(odd_ref.as_bytes(), &[]).is_err());
    }
}
