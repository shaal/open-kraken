import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toGitCommandError, type GitAdapter } from "./adapter";
import type { FileChange } from "./bindings/FileChange";
import type { GraphData } from "./bindings/GraphData";
import type { RepoInfo } from "./bindings/RepoInfo";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toGitCommandError(error);
  }
}

/** Reads repositories through the Rust commands in `src-tauri/src/commands.rs`. */
export const tauriAdapter: GitAdapter = {
  initialRepoPath: () => call<string | null>("initial_repo_path"),
  async pickFolder() {
    try {
      const picked = await open({ directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    } catch (error) {
      throw toGitCommandError(error);
    }
  },
  openRepo: (path) => call<RepoInfo>("open_repo", { path }),
  graphData: (root) => call<GraphData>("graph_data", { root }),
  commitFiles: (root, sha) => call<FileChange[]>("commit_files", { root, sha }),
  rangeFiles: (root, shas) => call<FileChange[]>("range_files", { root, shas }),
};
