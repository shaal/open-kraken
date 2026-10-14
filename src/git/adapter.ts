import type { ErrorInfo } from "./bindings/ErrorInfo";
import type { FileChange } from "./bindings/FileChange";
import type { GraphData } from "./bindings/GraphData";
import type { RepoInfo } from "./bindings/RepoInfo";

/**
 * How the UI reads a repository. The Tauri adapter calls the Rust commands;
 * the fixture adapter serves `fixtures/demo-repo.json` (browser and tests).
 */
export interface GitAdapter {
  /** The repository path given on the command line, or null. */
  initialRepoPath(): Promise<string | null>;
  /** Asks for a folder; null when cancelled or when there is no folder picker. */
  pickFolder(): Promise<string | null>;
  openRepo(path: string): Promise<RepoInfo>;
  graphData(root: string): Promise<GraphData>;
  commitFiles(root: string, sha: string): Promise<FileChange[]>;
  rangeFiles(root: string, shas: string[]): Promise<FileChange[]>;
}

/** Every adapter method rejects with this error. */
export class GitCommandError extends Error {
  readonly info: ErrorInfo;

  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = "GitCommandError";
    this.info = info;
  }
}

/** Turns anything a command rejected with into a GitCommandError. */
export function toGitCommandError(error: unknown): GitCommandError {
  if (error instanceof GitCommandError) {
    return error;
  }
  if (isErrorInfo(error)) {
    return new GitCommandError(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GitCommandError({ kind: "internal", message, path: null, root: null });
}

function isErrorInfo(value: unknown): value is ErrorInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string" && typeof candidate.message === "string";
}

/** The key the fixture uses for a selection: sorted, unique shas joined with ",". */
export function rangeKey(shas: readonly string[]): string {
  return [...new Set(shas)].sort().join(",");
}
