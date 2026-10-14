//! Reading commit history.

use serde::Serialize;

use crate::error::GitError;
use crate::repo::{Repo, unexpected};

/// One commit in the history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Full object id (40 hex digits for SHA-1, 64 for SHA-256).
    pub sha: String,
    /// Parent ids, first parent first. Empty for a root commit, and for the
    /// boundary commits of a shallow clone (git lists them as roots).
    pub parents: Vec<String>,
    /// Author name and email, after `.mailmap`.
    pub author_name: String,
    pub author_email: String,
    /// When the commit was authored: Unix time in seconds, and the author's UTC
    /// offset in minutes (east positive). Both are 0 if git cannot read the date.
    pub author_time: i64,
    pub author_tz_offset: i32,
    /// When the commit was committed, in Unix seconds (0 if unreadable). Used to
    /// order history newest first.
    pub committer_time: i64,
    /// First paragraph of the message, joined into one line (git's `%s`).
    pub subject: String,
}

/// Field placeholders, separated by NUL. With `-z`, git also ends every commit
/// with a NUL, so the output is a flat list of exactly `FIELDS` values per commit.
/// Dates use `--date=raw`: "<unix seconds> <+hhmm>".
const LOG_FORMAT: &str = "--format=%H%x00%P%x00%aN%x00%aE%x00%ad%x00%cd%x00%s";
const FIELDS: usize = 7;

impl Repo {
    /// Every commit reachable from local branches, remote branches, tags and HEAD
    /// (stash commits are not included), children before parents. An empty
    /// repository gives an empty list.
    ///
    /// The history is what `git log` shows, so replace refs (`refs/replace/`) are
    /// honored, as they are by the git commands that later act on it. A corrupt
    /// commit with NUL bytes in its headers gives [`GitError::UnexpectedOutput`].
    pub fn log(&self) -> Result<Vec<Commit>, GitError> {
        let mut args = vec![
            "log",
            "--date-order",
            "--date=raw",
            "-z",
            LOG_FORMAT,
            "--branches",
            "--remotes",
            "--tags",
        ];
        // A detached HEAD can point at commits that no branch or tag contains.
        if self.head_commit()?.is_some() {
            args.push("HEAD");
        }
        args.push("--");
        let out = self.run(&args)?;
        parse_log(&out).map_err(|detail| unexpected(&args, detail))
    }
}

/// Parses `git log -z` output written with [`LOG_FORMAT`].
pub(crate) fn parse_log(out: &[u8]) -> Result<Vec<Commit>, String> {
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
    fields.chunks(FIELDS).map(parse_commit).collect()
}

fn parse_commit(f: &[&[u8]]) -> Result<Commit, String> {
    let [
        sha,
        parents,
        name,
        email,
        author_date,
        committer_date,
        subject,
    ] = f
    else {
        return Err("wrong field count".to_owned());
    };
    let sha = object_id(sha)?;
    let parents = if parents.is_empty() {
        Vec::new()
    } else {
        parents
            .split(|b| *b == b' ')
            .map(object_id)
            .collect::<Result<_, _>>()?
    };
    Ok(Commit {
        sha,
        parents,
        author_name: text(name),
        author_email: text(email),
        author_time: raw_date(author_date).0,
        author_tz_offset: raw_date(author_date).1,
        committer_time: raw_date(committer_date).0,
        subject: text(subject),
    })
}

/// A full object id: 40 (SHA-1) or 64 (SHA-256) lowercase hex digits.
pub(crate) fn object_id(bytes: &[u8]) -> Result<String, String> {
    let valid = matches!(bytes.len(), 40 | 64)
        && bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if valid {
        Ok(String::from_utf8_lossy(bytes).into_owned())
    } else {
        Err(format!("not an object id: {:?}", text(bytes)))
    }
}

/// Parses a `--date=raw` date, "1759307200 +0200", into (Unix seconds, UTC offset
/// in minutes). A date git cannot read (empty, out of range) reads as (0, 0), so
/// one malformed commit does not hide the rest of the history.
fn raw_date(bytes: &[u8]) -> (i64, i32) {
    let parse = || -> Option<(i64, i32)> {
        let text = std::str::from_utf8(bytes).ok()?;
        let (seconds, zone) = text.split_once(' ')?;
        let seconds = seconds.parse().ok()?;
        let (sign, digits) = match zone.as_bytes().first()? {
            b'+' => (1, &zone[1..]),
            b'-' => (-1, &zone[1..]),
            _ => return None,
        };
        if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let hours: i32 = digits[..2].parse().ok()?;
        let minutes: i32 = digits[2..].parse().ok()?;
        Some((seconds, sign * (hours * 60 + minutes)))
    };
    parse().unwrap_or((0, 0))
}

/// Git passes names and messages through as bytes; invalid UTF-8 becomes U+FFFD.
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";
    const C: &str = "3333333333333333333333333333333333333333";
    const D: &[u8] = b"1 +0000";

    fn record(fields: [&[u8]; FIELDS]) -> Vec<u8> {
        let mut out = fields.join(&b"\0"[..]);
        out.push(0);
        out
    }

    #[test]
    fn empty_output_is_no_commits() {
        assert_eq!(parse_log(b""), Ok(Vec::new()));
    }

    #[test]
    fn parses_root_merge_and_octopus_commits() {
        let merge = format!("{A} {B}");
        let octopus = format!("{A} {B} {C}");
        let mut out = record([
            C.as_bytes(),
            b"",
            b"Ann",
            b"a@x",
            b"10 +0000",
            b"11 +0000",
            b"root",
        ]);
        out.extend(record([
            A.as_bytes(),
            merge.as_bytes(),
            b"Bo",
            b"bo@x",
            b"20 +0530",
            b"21 -0100",
            b"Merge branch 'x'",
        ]));
        out.extend(record([
            B.as_bytes(),
            octopus.as_bytes(),
            b"Cy",
            b"cy@x",
            b"-5 -0800",
            b"30 +0000",
            b"octopus",
        ]));
        let commits = parse_log(&out).unwrap();
        assert_eq!(commits.len(), 3);
        assert!(commits[0].parents.is_empty());
        assert_eq!(commits[1].parents, vec![A, B]);
        assert_eq!(commits[2].parents, vec![A, B, C]);
        assert_eq!(commits[1].author_name, "Bo");
        assert_eq!(
            (commits[1].author_time, commits[1].committer_time),
            (20, 21)
        );
        assert_eq!(commits[1].author_tz_offset, 5 * 60 + 30);
        assert_eq!(
            (commits[2].author_time, commits[2].author_tz_offset),
            (-5, -8 * 60)
        );
    }

    #[test]
    fn unreadable_dates_read_as_zero_without_failing() {
        for bad in [
            &b""[..],
            b"soon +0000",
            b"12",
            b"12 0100",
            b"12 +01",
            b"12 +01x0",
        ] {
            let out = record([A.as_bytes(), b"", b"n", b"e", bad, bad, b"s"]);
            let commit = &parse_log(&out).unwrap()[0];
            assert_eq!(
                (commit.author_time, commit.author_tz_offset),
                (0, 0),
                "{bad:?}"
            );
            assert_eq!(commit.committer_time, 0);
        }
    }

    #[test]
    fn keeps_tabs_percent_signs_and_unicode_in_subjects() {
        let subject = "tab\there, 100% %s %H, émoji 🐙";
        let out = record([
            A.as_bytes(),
            b"",
            "Zoë".as_bytes(),
            b"z@x",
            D,
            D,
            subject.as_bytes(),
        ]);
        let commit = &parse_log(&out).unwrap()[0];
        assert_eq!(commit.subject, subject);
        assert_eq!(commit.author_name, "Zoë");
    }

    #[test]
    fn invalid_utf8_is_replaced_without_shifting_fields() {
        let mut out = record([A.as_bytes(), b"", b"J\xe9r\xf4me", b"j@x", D, D, b"caf\xe9"]);
        out.extend(record([
            B.as_bytes(),
            A.as_bytes(),
            b"K",
            b"k@x",
            D,
            D,
            b"next",
        ]));
        let commits = parse_log(&out).unwrap();
        assert_eq!(commits[0].author_name, "J\u{fffd}r\u{fffd}me");
        assert_eq!(commits[0].subject, "caf\u{fffd}");
        assert_eq!(commits[1].sha, B);
        assert_eq!(commits[1].subject, "next");
    }

    #[test]
    fn accepts_sha256_ids() {
        let long = "a".repeat(64);
        let out = record([long.as_bytes(), b"", b"n", b"e", D, D, b"s"]);
        assert_eq!(parse_log(&out).unwrap()[0].sha, long);
    }

    #[test]
    fn rejects_malformed_output() {
        // Missing the final NUL; wrong field count.
        assert!(parse_log(b"abc").is_err());
        assert!(parse_log(b"a\0b\0").is_err());
        // Bad object id or parent: the fields are misaligned or corrupt.
        assert!(parse_log(&record([b"xyz", b"", b"n", b"e", D, D, b"s"])).is_err());
        let bad_parent = record([A.as_bytes(), b"nope", b"n", b"e", D, D, b"s"]);
        assert!(parse_log(&bad_parent).is_err());
        // Uppercase hex is not what git prints.
        let upper = record([
            b"ABCDEF0123456789ABCDEF0123456789ABCDEF01",
            b"",
            b"n",
            b"e",
            D,
            D,
            b"s",
        ]);
        assert!(parse_log(&upper).is_err());
        // A NUL inside a field shifts every later field: detected, not misread.
        let mut shifted = record([A.as_bytes(), b"", b"na\0me", b"e", D, D, b"s"]);
        shifted.extend(record([B.as_bytes(), b"", b"n", b"e", D, D, b"s"]));
        assert!(parse_log(&shifted).is_err());
    }
}
