//! The installed git version and the minimum open-kraken supports.

use std::ffi::OsStr;
use std::fmt;
use std::process::Command;

/// The oldest git release open-kraken supports (same floor as the fixture script).
pub const MIN_GIT_VERSION: GitVersion = GitVersion {
    major: 2,
    minor: 32,
    patch: 0,
};

/// A git release number, such as 2.43.0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl fmt::Display for GitVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Parses the output of `git version`, for example `git version 2.43.0` or
/// `git version 2.39.5 (Apple Git-154)`. A missing patch number reads as 0.
pub fn parse_git_version(output: &str) -> Option<GitVersion> {
    let rest = output.trim().strip_prefix("git version ")?;
    let number = rest.split_whitespace().next()?;
    let mut parts = number.split('.');
    let major = leading_number(parts.next()?)?;
    let minor = leading_number(parts.next()?)?;
    let patch = parts.next().and_then(leading_number).unwrap_or(0);
    Some(GitVersion {
        major,
        minor,
        patch,
    })
}

/// Reads the digits at the start of `part` ("43" in "43rc1"); `None` if there are none.
fn leading_number(part: &str) -> Option<u32> {
    let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Why the installed git could not be used.
#[derive(Debug)]
pub enum GitVersionError {
    /// `git` could not be started (not installed or not on PATH).
    NotFound(std::io::Error),
    /// `git version` ran but exited with an error.
    Failed {
        /// Exit code, or `None` when a signal ended the process.
        code: Option<i32>,
        stderr: String,
    },
    /// `git version` ran but its output was not recognized.
    Unrecognized(String),
    /// The installed git is older than [`MIN_GIT_VERSION`].
    TooOld(GitVersion),
}

impl fmt::Display for GitVersionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(err) => write!(f, "git could not be started: {err}"),
            Self::Failed { code, stderr } => {
                let code = code.map_or_else(|| "a signal".to_owned(), |c| format!("code {c}"));
                write!(f, "`git version` failed with {code}: {}", stderr.trim())
            }
            Self::Unrecognized(output) => {
                write!(f, "unrecognized `git version` output: {output:?}")
            }
            Self::TooOld(version) => {
                write!(
                    f,
                    "git {version} is too old; {MIN_GIT_VERSION} or newer is required"
                )
            }
        }
    }
}

impl std::error::Error for GitVersionError {}

/// Runs `git version` and checks it against [`MIN_GIT_VERSION`].
pub fn installed_git_version() -> Result<GitVersion, GitVersionError> {
    git_version_of("git")
}

/// Same as [`installed_git_version`] for a given git executable.
fn git_version_of(program: impl AsRef<OsStr>) -> Result<GitVersion, GitVersionError> {
    let output = Command::new(program)
        .arg("version")
        .output()
        .map_err(GitVersionError::NotFound)?;
    if !output.status.success() {
        return Err(GitVersionError::Failed {
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let version = parse_git_version(&text).ok_or(GitVersionError::Unrecognized(text))?;
    if version < MIN_GIT_VERSION {
        return Err(GitVersionError::TooOld(version));
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(major: u32, minor: u32, patch: u32) -> GitVersion {
        GitVersion {
            major,
            minor,
            patch,
        }
    }

    #[test]
    fn parses_plain_versions() {
        assert_eq!(parse_git_version("git version 2.43.0\n"), Some(v(2, 43, 0)));
        assert_eq!(parse_git_version("git version 2.56.0"), Some(v(2, 56, 0)));
    }

    #[test]
    fn parses_vendor_suffixes() {
        assert_eq!(
            parse_git_version("git version 2.39.5 (Apple Git-154)"),
            Some(v(2, 39, 5))
        );
        assert_eq!(
            parse_git_version("git version 2.45.1.windows.1"),
            Some(v(2, 45, 1))
        );
        assert_eq!(
            parse_git_version("git version 2.47.0-rc1"),
            Some(v(2, 47, 0))
        );
        assert_eq!(
            parse_git_version("git version 2.50.0.rc2"),
            Some(v(2, 50, 0))
        );
    }

    #[test]
    fn missing_patch_reads_as_zero() {
        assert_eq!(parse_git_version("git version 3.0"), Some(v(3, 0, 0)));
    }

    #[test]
    fn rejects_unrecognized_output() {
        assert_eq!(parse_git_version(""), None);
        assert_eq!(parse_git_version("hub version 2.14.2"), None);
        assert_eq!(parse_git_version("git version"), None);
        assert_eq!(parse_git_version("git version x.y.z"), None);
        assert_eq!(parse_git_version("git version 2"), None);
    }

    #[test]
    fn orders_versions_numerically() {
        assert!(v(2, 9, 0) < v(2, 32, 0));
        assert!(v(2, 32, 0) >= MIN_GIT_VERSION);
        assert!(v(2, 31, 9) < MIN_GIT_VERSION);
        assert!(v(3, 0, 0) > MIN_GIT_VERSION);
    }

    #[test]
    fn installed_git_is_supported() {
        let version = installed_git_version().expect("git 2.32+ must be installed to run tests");
        assert!(version >= MIN_GIT_VERSION);
    }

    #[test]
    fn missing_program_is_not_found() {
        let err = git_version_of("open-kraken-no-such-git").unwrap_err();
        assert!(matches!(err, GitVersionError::NotFound(_)), "{err:?}");
    }

    #[test]
    #[cfg(unix)]
    fn failing_program_reports_its_exit_code() {
        // `false` exits 1 without output, like a broken git would.
        let err = git_version_of("false").unwrap_err();
        assert!(
            matches!(err, GitVersionError::Failed { code: Some(1), .. }),
            "{err:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn non_git_output_is_unrecognized() {
        // `echo version` prints "version", which is not `git version X.Y`.
        let err = git_version_of("echo").unwrap_err();
        assert!(matches!(err, GitVersionError::Unrecognized(_)), "{err:?}");
    }

    #[test]
    fn errors_explain_themselves() {
        let too_old = GitVersionError::TooOld(v(2, 25, 1)).to_string();
        assert_eq!(
            too_old,
            "git 2.25.1 is too old; 2.32.0 or newer is required"
        );
        let failed = GitVersionError::Failed {
            code: Some(128),
            stderr: "fatal: oops\n".to_owned(),
        }
        .to_string();
        assert_eq!(failed, "`git version` failed with code 128: fatal: oops");
    }
}
