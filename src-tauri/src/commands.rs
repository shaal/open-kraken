//! The commands the frontend calls (`invoke`). Each one opens the repository at
//! `root` and runs git off the main thread, so the window never waits on git.

use git_data::{ErrorInfo, FileChange, GraphData, Repo, RepoInfo};

/// Runs blocking git work on a worker thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, git_data::GitError> + Send + 'static,
) -> Result<T, ErrorInfo> {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result.map_err(ErrorInfo::from),
        Err(err) => Err(ErrorInfo::internal(format!(
            "background task failed: {err}"
        ))),
    }
}

/// The repository path given on the command line, if any.
#[tauri::command]
pub fn initial_repo_path() -> Option<String> {
    // args_os: a non-UTF-8 argument must not panic (it is shown with U+FFFD).
    let args = std::env::args_os().skip(1);
    repo_path_from_args(args.map(|arg| arg.to_string_lossy().into_owned()))
}

/// Opens the repository whose root is `path` and says where it is.
#[tauri::command]
pub async fn open_repo(path: String) -> Result<RepoInfo, ErrorInfo> {
    blocking(move || Repo::open(&path).map(|repo| repo.info())).await
}

/// History, refs, working tree and stashes of the repository at `root`.
#[tauri::command]
pub async fn graph_data(root: String) -> Result<GraphData, ErrorInfo> {
    blocking(move || Repo::open(&root)?.graph_data()).await
}

/// The files one commit changed.
#[tauri::command]
pub async fn commit_files(root: String, sha: String) -> Result<Vec<FileChange>, ErrorInfo> {
    blocking(move || Repo::open(&root)?.commit_files(&sha)).await
}

/// The files a multi-selection changed (see `Repo::range_files`).
#[tauri::command]
pub async fn range_files(root: String, shas: Vec<String>) -> Result<Vec<FileChange>, ErrorInfo> {
    blocking(move || {
        let shas: Vec<&str> = shas.iter().map(String::as_str).collect();
        Repo::open(&root)?.range_files(&shas)
    })
    .await
}

/// The first argument that is not an option. macOS may add its own arguments:
/// `-psn_…` (Finder) and `-NSKey value` / `-AppleKey value` defaults, whose value
/// is skipped too.
fn repo_path_from_args(args: impl IntoIterator<Item = String>) -> Option<String> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg.starts_with("-NS") || arg.starts_with("-Apple") {
            args.next(); // the default's value, for example "(de)"
        } else if !arg.starts_with('-') {
            return Some(arg);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn picks_the_first_non_option_argument() {
        assert_eq!(repo_path_from_args(args(&[])), None);
        assert_eq!(
            repo_path_from_args(args(&["/repos/a"])),
            Some("/repos/a".into())
        );
        assert_eq!(
            repo_path_from_args(args(&["-psn_0_12345", "/repos/a", "/repos/b"])),
            Some("/repos/a".into())
        );
        assert_eq!(repo_path_from_args(args(&["--flag"])), None);
        assert_eq!(
            repo_path_from_args(args(&["-AppleLanguages", "(de)", "/repos/a"])),
            Some("/repos/a".into())
        );
        assert_eq!(
            repo_path_from_args(args(&["-NSDocumentRevisionsDebugMode", "YES"])),
            None
        );
    }
}
