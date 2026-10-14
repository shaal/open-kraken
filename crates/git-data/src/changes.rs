//! Changed files: the working tree status, and the files changed by commits.

use serde::Serialize;

use crate::error::GitError;
use crate::log::object_id;
use crate::repo::{Repo, unexpected};

/// How a file changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    /// The file type changed (for example a file became a symlink).
    TypeChanged,
    /// Not tracked by git yet.
    Untracked,
    /// A merge conflict that is not resolved yet.
    Conflicted,
}

/// One changed file. Paths are relative to the work tree root and use `/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// The previous path of a renamed or copied file.
    pub old_path: Option<String>,
    pub kind: ChangeKind,
}

/// Uncommitted changes in the work tree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeStatus {
    /// Changes in the index (what the next commit would contain).
    pub staged: Vec<FileChange>,
    /// Changes in the work tree that are not staged, including untracked files.
    pub unstaged: Vec<FileChange>,
    /// Files with unresolved merge conflicts.
    pub conflicted: Vec<FileChange>,
}

impl WorkingTreeStatus {
    /// True when there is nothing to commit and nothing untracked.
    pub fn is_clean(&self) -> bool {
        self.staged.is_empty() && self.unstaged.is_empty() && self.conflicted.is_empty()
    }
}

impl Repo {
    /// The uncommitted changes. Untracked files are listed one by one, not as
    /// folders; the exception is an untracked nested repository, which git lists
    /// as one entry whose path ends in `/`. Ignored files are not listed. A bare
    /// repository has none.
    pub fn status(&self) -> Result<WorkingTreeStatus, GitError> {
        if self.work_dir().is_none() {
            return Ok(WorkingTreeStatus::default());
        }
        let args = [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--renames",
            // Report submodule changes even if .gitmodules or config says to hide them.
            "--ignore-submodules=none",
        ];
        let out = self.run(&args)?;
        parse_status(&out).map_err(|detail| unexpected(&args, detail))
    }

    /// The files one commit changed, compared with its first parent (a root
    /// commit is compared with an empty tree). Renames are detected.
    pub fn commit_files(&self, sha: &str) -> Result<Vec<FileChange>, GitError> {
        let sha = checked_sha(sha)?;
        let parent = self.first_parent(sha)?;
        self.diff_files(parent.as_deref(), sha)
    }

    /// The files changed by a multi-selection of commits, as the details panel
    /// shows them (spec §4):
    /// - exactly 2 commits: the difference between the two (older to newer);
    /// - 3 or more: one combined diff, from the first parent of the oldest to the
    ///   newest (so the oldest commit's own changes are included).
    ///
    /// "Older" and "newer" follow ancestry (a parent is always older than its
    /// child, whatever the dates say); unrelated commits go by commit date.
    /// Duplicates are ignored. One commit is the same as [`Repo::commit_files`].
    pub fn range_files(&self, shas: &[&str]) -> Result<Vec<FileChange>, GitError> {
        let mut selected: Vec<&str> = Vec::new();
        for sha in shas {
            let sha = checked_sha(sha)?;
            if !selected.contains(&sha) {
                selected.push(sha);
            }
        }
        // A fixed input order makes ties (unrelated commits with the same date)
        // come out the same way whatever order the commits were selected in.
        selected.sort_unstable();
        match selected.as_slice() {
            [] => return Err(GitError::InvalidArgument("no commits selected".into())),
            [one] => return self.commit_files(one),
            _ => {}
        }
        // Walk only down to the selection's common ancestor (when there is one):
        // without the bound, rev-list would walk the whole history every time.
        let mut base_args = vec!["merge-base", "--octopus"];
        base_args.extend(selected.iter().copied());
        let stop = match self.run_optional(&base_args)? {
            Some(out) => {
                let base = object_id(out.strip_suffix(b"\n").unwrap_or(&out))
                    .map_err(|d| unexpected(&base_args, d))?;
                Some(format!("^{base}^@"))
            }
            None => None, // no shared history
        };
        // --date-order never shows a parent before its children, and otherwise
        // follows commit dates: newest first.
        let mut args = vec!["rev-list", "--date-order"];
        args.extend(selected.iter().copied());
        args.extend(stop.as_deref());
        args.push("--");
        let out = self.run(&args)?;
        let wanted: std::collections::HashSet<&str> = selected.iter().copied().collect();
        let ordered: Vec<&str> = out
            .split(|b| *b == b'\n')
            .filter_map(|line| std::str::from_utf8(line).ok())
            .filter(|sha| wanted.contains(sha))
            .collect();
        if ordered.len() != selected.len() {
            return Err(unexpected(&args, "not every selected commit was listed"));
        }
        let (newest, oldest) = (ordered[0], ordered[ordered.len() - 1]);
        match ordered.len() {
            2 => self.diff_files(Some(oldest), newest),
            _ => {
                let base = self.first_parent(oldest)?;
                self.diff_files(base.as_deref(), newest)
            }
        }
    }

    /// The id of the empty tree in this repository's hash format.
    fn empty_tree(&self) -> Result<String, GitError> {
        // Stdin is empty (Command::output closes it), so this hashes nothing.
        let args = ["hash-object", "-t", "tree", "--stdin"];
        let out = self.run(&args)?;
        object_id(out.strip_suffix(b"\n").unwrap_or(&out)).map_err(|d| unexpected(&args, d))
    }

    /// The first parent, or `None` for a root commit (and for the boundary commits
    /// of a shallow clone, which git also treats as roots, as `git show` does).
    fn first_parent(&self, sha: &str) -> Result<Option<String>, GitError> {
        let spec = format!("{sha}^1");
        let args = ["rev-parse", "-q", "--verify", "--end-of-options", &spec];
        match self.run_optional(&args)? {
            Some(out) => object_id(out.strip_suffix(b"\n").unwrap_or(&out))
                .map(Some)
                .map_err(|d| unexpected(&args, d)),
            None => Ok(None),
        }
    }

    /// Files that differ between two commits (`None` = the empty tree). Always the
    /// two-tree form: `diff-tree --root <merge>` would print nothing for a merge.
    fn diff_files(&self, from: Option<&str>, to: &str) -> Result<Vec<FileChange>, GitError> {
        let empty_tree;
        let from = match from {
            Some(from) => from,
            None => {
                empty_tree = self.empty_tree()?;
                &empty_tree
            }
        };
        let args = [
            "diff-tree",
            "-r",
            "-z",
            "-M",
            "--name-status",
            "--no-commit-id",
            from,
            to,
            "--",
        ];
        let out = self.run(&args)?;
        parse_name_status(&out).map_err(|detail| unexpected(&args, detail))
    }
}

/// Only full object ids are passed to git, so a value from the UI can never be
/// read as an option or a revision expression.
fn checked_sha(sha: &str) -> Result<&str, GitError> {
    object_id(sha.as_bytes())
        .map(|_| sha)
        .map_err(GitError::InvalidArgument)
}

/// Parses `git status --porcelain=v2 -z` output.
pub(crate) fn parse_status(out: &[u8]) -> Result<WorkingTreeStatus, String> {
    let mut status = WorkingTreeStatus::default();
    let mut tokens = out.split(|b| *b == 0);
    while let Some(entry) = tokens.next() {
        let Some(&marker) = entry.first() else {
            continue; // the empty token after the final NUL
        };
        match marker {
            b'1' | b'2' => {
                // "1 XY sub mH mI mW hH hI path" or "2 XY sub mH mI mW hH hI Xscore path".
                let count = if marker == b'1' { 9 } else { 10 };
                let fields: Vec<&[u8]> = entry.splitn(count, |b| *b == b' ').collect();
                if fields.len() != count {
                    return Err(format!("short status entry {:?}", text(entry)));
                }
                let xy = fields[1];
                let path = text(fields[count - 1]);
                let old_path = if marker == b'2' {
                    let old = tokens
                        .next()
                        .filter(|path| !path.is_empty())
                        .ok_or("rename entry without its old path")?;
                    Some(text(old))
                } else {
                    None
                };
                let [x, y] = xy else {
                    return Err(format!("bad XY {:?}", text(xy)));
                };
                if let Some(kind) = change_kind(*x)? {
                    status.staged.push(change(&path, &old_path, kind));
                }
                if let Some(kind) = change_kind(*y)? {
                    status.unstaged.push(change(&path, &old_path, kind));
                }
            }
            b'u' => {
                // "u XY sub m1 m2 m3 mW h1 h2 h3 path"
                let fields: Vec<&[u8]> = entry.splitn(11, |b| *b == b' ').collect();
                let path = fields
                    .get(10)
                    .ok_or_else(|| format!("short conflict entry {:?}", text(entry)))?;
                status.conflicted.push(FileChange {
                    path: text(path),
                    old_path: None,
                    kind: ChangeKind::Conflicted,
                });
            }
            b'?' => {
                let path = entry.get(2..).ok_or("empty untracked entry")?;
                status.unstaged.push(FileChange {
                    path: text(path),
                    old_path: None,
                    kind: ChangeKind::Untracked,
                });
            }
            b'!' | b'#' => {} // ignored files and headers (not requested)
            _ => return Err(format!("unknown status entry {:?}", text(entry))),
        }
    }
    Ok(status)
}

fn change(path: &str, old_path: &Option<String>, kind: ChangeKind) -> FileChange {
    let renamed = matches!(kind, ChangeKind::Renamed | ChangeKind::Copied);
    FileChange {
        path: path.to_owned(),
        old_path: if renamed { old_path.clone() } else { None },
        kind,
    }
}

/// One side (X or Y) of a porcelain status code; `.` means unchanged.
fn change_kind(code: u8) -> Result<Option<ChangeKind>, String> {
    Ok(Some(match code {
        b'.' => return Ok(None),
        b'M' => ChangeKind::Modified,
        b'A' => ChangeKind::Added,
        b'D' => ChangeKind::Deleted,
        b'R' => ChangeKind::Renamed,
        b'C' => ChangeKind::Copied,
        b'T' => ChangeKind::TypeChanged,
        b'U' => ChangeKind::Conflicted,
        other => return Err(format!("unknown status code {:?}", other as char)),
    }))
}

/// Parses `git diff-tree -z --name-status` output: "X\0path\0", or
/// "R<score>\0old\0new\0" for renames and copies.
pub(crate) fn parse_name_status(out: &[u8]) -> Result<Vec<FileChange>, String> {
    let mut changes = Vec::new();
    let mut tokens = out.split(|b| *b == 0);
    while let Some(code) = tokens.next() {
        let Some(&letter) = code.first() else {
            continue;
        };
        // Paths are never empty; an empty token is the end of the output.
        let mut next = || {
            tokens
                .next()
                .filter(|path| !path.is_empty())
                .ok_or("status without a path")
                .map(text)
        };
        let (kind, old_path, path) = match letter {
            b'A' => (ChangeKind::Added, None, next()?),
            b'M' => (ChangeKind::Modified, None, next()?),
            b'D' => (ChangeKind::Deleted, None, next()?),
            b'T' => (ChangeKind::TypeChanged, None, next()?),
            b'U' => (ChangeKind::Conflicted, None, next()?),
            b'R' | b'C' => {
                let old = next()?;
                let new = next()?;
                let kind = if letter == b'R' {
                    ChangeKind::Renamed
                } else {
                    ChangeKind::Copied
                };
                (kind, Some(old), new)
            }
            _ => return Err(format!("unknown change {:?}", text(code))),
        };
        changes.push(FileChange {
            path,
            old_path,
            kind,
        });
    }
    Ok(changes)
}

/// Git passes paths through as bytes; invalid UTF-8 becomes U+FFFD.
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, kind: ChangeKind) -> FileChange {
        FileChange {
            path: path.into(),
            old_path: None,
            kind,
        }
    }

    const H: &str = "100644 100644 100644 aaaa bbbb";

    #[test]
    fn parses_every_status_entry_type() {
        let out = [
            format!("1 .M N... {H} README.md"),
            format!("2 R. N... {H} R100 build tool.sh"),
            "build.sh".to_owned(),
            format!("1 MM N... {H} docs.md"),
            format!("1 A. N... {H} new file.txt"),
            format!("1 D. N... {H} gone.txt"),
            format!("1 .D N... {H} deleted in tree.txt"),
            format!("1 .T N... {H} link"),
            "u UU N... 100644 100644 100644 100644 a b c both edited.txt".to_owned(),
            "? notes.txt".to_owned(),
            "? dir/new file.txt".to_owned(),
            "# branch.oid abc".to_owned(),
            "! ignored.log".to_owned(),
        ]
        .join("\0")
            + "\0";
        let status = parse_status(out.as_bytes()).unwrap();
        assert_eq!(
            status.staged,
            vec![
                FileChange {
                    path: "build tool.sh".into(),
                    old_path: Some("build.sh".into()),
                    kind: ChangeKind::Renamed
                },
                f("docs.md", ChangeKind::Modified),
                f("new file.txt", ChangeKind::Added),
                f("gone.txt", ChangeKind::Deleted),
            ]
        );
        assert_eq!(
            status.unstaged,
            vec![
                f("README.md", ChangeKind::Modified),
                f("docs.md", ChangeKind::Modified),
                f("deleted in tree.txt", ChangeKind::Deleted),
                f("link", ChangeKind::TypeChanged),
                f("notes.txt", ChangeKind::Untracked),
                f("dir/new file.txt", ChangeKind::Untracked),
            ]
        );
        assert_eq!(
            status.conflicted,
            vec![f("both edited.txt", ChangeKind::Conflicted)]
        );
        assert!(!status.is_clean());
    }

    #[test]
    fn empty_status_is_clean() {
        let status = parse_status(b"").unwrap();
        assert!(status.is_clean());
    }

    #[test]
    fn paths_keep_spaces_and_newlines() {
        let out = format!("1 .M N... {H} a b\nc.txt\0? x\ny z\0");
        let status = parse_status(out.as_bytes()).unwrap();
        assert_eq!(status.unstaged[0].path, "a b\nc.txt");
        assert_eq!(status.unstaged[1].path, "x\ny z");
    }

    #[test]
    fn rejects_malformed_status() {
        assert!(parse_status(b"1 .M short\0").is_err());
        assert!(parse_status(format!("2 R. N... {H} R100 only-new").as_bytes()).is_err());
        assert!(parse_status(format!("1 .Z N... {H} p\0").as_bytes()).is_err());
        assert!(parse_status(b"x what\0").is_err());
    }

    #[test]
    fn parses_name_status() {
        let out = b"A\0new.txt\0M\0mod.txt\0D\0del.txt\0T\0link\0R087\0old name\0new name\0C100\0src\0copy\0";
        let changes = parse_name_status(out).unwrap();
        assert_eq!(changes.len(), 6);
        assert_eq!(changes[0], f("new.txt", ChangeKind::Added));
        assert_eq!(changes[3], f("link", ChangeKind::TypeChanged));
        assert_eq!(
            changes[4],
            FileChange {
                path: "new name".into(),
                old_path: Some("old name".into()),
                kind: ChangeKind::Renamed
            }
        );
        assert_eq!(changes[5].kind, ChangeKind::Copied);
        assert_eq!(changes[5].old_path.as_deref(), Some("src"));
        assert!(parse_name_status(b"M\0").is_err());
        assert!(parse_name_status(b"R100\0only-old\0").is_err());
        assert!(parse_name_status(b"Q\0x\0").is_err());
    }

    #[test]
    fn only_full_object_ids_reach_git() {
        for bad in [
            "--output=/tmp/x",
            "HEAD",
            "main",
            "abc",
            "1111111111111111111111111111111111111111^",
        ] {
            assert!(
                matches!(checked_sha(bad), Err(GitError::InvalidArgument(_))),
                "{bad}"
            );
        }
        assert!(checked_sha("1111111111111111111111111111111111111111").is_ok());
    }
}
