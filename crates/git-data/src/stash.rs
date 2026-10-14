//! Reading stashes.

use serde::Serialize;

use crate::error::GitError;
use crate::log::object_id;
use crate::repo::{Repo, unexpected};

/// One stash entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    /// Position in the stash list; 0 is the newest.
    pub index: usize,
    /// The name git uses for it, for example `stash@{0}`.
    pub selector: String,
    /// The stash message, for example "On main: WIP: experiment with caching".
    pub message: String,
    /// The stash commit.
    pub sha: String,
    /// The commit the stash was made on (the stash commit's first parent).
    pub base_sha: String,
    /// When the stash was made, in Unix seconds.
    pub time: i64,
}

/// sha, parents, message, time; NUL-separated, NUL-terminated with `-z`.
const STASH_FORMAT: &str = "--format=%H%x00%P%x00%gs%x00%ct";
const FIELDS: usize = 4;

impl Repo {
    /// The stash list, newest first. Empty when there are no stashes.
    pub fn stashes(&self) -> Result<Vec<Stash>, GitError> {
        // `git stash list` needs a work tree; reading the stash reflog does not.
        let exists = ["rev-parse", "-q", "--verify", "refs/stash"];
        if self.run_optional(&exists)?.is_none() {
            return Ok(Vec::new());
        }
        let args = ["log", "-g", "-z", STASH_FORMAT, "refs/stash", "--"];
        let out = self.run(&args)?;
        parse_stashes(&out).map_err(|detail| unexpected(&args, detail))
    }
}

pub(crate) fn parse_stashes(out: &[u8]) -> Result<Vec<Stash>, String> {
    if out.is_empty() {
        return Ok(Vec::new());
    }
    let body = out
        .strip_suffix(b"\0")
        .ok_or("output does not end with a NUL")?;
    let fields: Vec<&[u8]> = body.split(|b| *b == 0).collect();
    if !fields.len().is_multiple_of(FIELDS) {
        return Err(format!(
            "{} fields is not a multiple of {FIELDS}",
            fields.len()
        ));
    }
    fields
        .chunks(FIELDS)
        .enumerate()
        .map(|(index, f)| {
            let [sha, parents, message, time] = f else {
                return Err("wrong field count".to_owned());
            };
            let base = parents
                .split(|b| *b == b' ')
                .next()
                .filter(|p| !p.is_empty())
                .ok_or("stash without a parent")?;
            Ok(Stash {
                index,
                selector: format!("stash@{{{index}}}"),
                message: String::from_utf8_lossy(message).into_owned(),
                sha: object_id(sha)?,
                base_sha: object_id(base)?,
                time: std::str::from_utf8(time)
                    .ok()
                    .and_then(|t| t.parse().ok())
                    .unwrap_or(0),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const S0: &str = "1111111111111111111111111111111111111111";
    const S1: &str = "2222222222222222222222222222222222222222";
    const B: &str = "3333333333333333333333333333333333333333";
    const I: &str = "4444444444444444444444444444444444444444";
    const U: &str = "5555555555555555555555555555555555555555";

    #[test]
    fn parses_stashes_newest_first() {
        let out = format!(
            "{S0}\0{B} {I} {U}\0On main: with untracked\x00100\0\
             {S1}\0{I} {B}\0WIP on main: abc subject\x0090\0"
        );
        let stashes = parse_stashes(out.as_bytes()).unwrap();
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[0].selector, "stash@{0}");
        assert_eq!(stashes[0].message, "On main: with untracked");
        assert_eq!(stashes[0].sha, S0);
        assert_eq!(stashes[0].base_sha, B, "first parent, even with 3 parents");
        assert_eq!(stashes[0].time, 100);
        assert_eq!(stashes[1].index, 1);
        assert_eq!(stashes[1].selector, "stash@{1}");
        assert_eq!(stashes[1].base_sha, I);
    }

    #[test]
    fn empty_and_malformed() {
        assert_eq!(parse_stashes(b""), Ok(Vec::new()));
        assert!(parse_stashes(b"x\0").is_err());
        let no_parent = format!("{S0}\0\0m\x001\0");
        assert!(parse_stashes(no_parent.as_bytes()).is_err());
    }
}
