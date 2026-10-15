import { GitCommandError, rangeKey, type GitAdapter } from "./adapter";
import type { Fixture } from "./bindings/Fixture";
import type { FileChange } from "./bindings/FileChange";

/**
 * Serves the demo repository from `fixtures/demo-repo.json` (written by
 * `scripts/update-fixture.sh`), so the UI runs in a browser and in tests.
 */
export function createFixtureAdapter(load: () => Promise<Fixture> = loadDemoFixture): GitAdapter {
  let fixture: Promise<Fixture> | undefined;
  const data = () => (fixture ??= load());
  // Real commands return new objects every call; so does the fixture.
  const fresh = <T>(value: T): T => structuredClone(value);

  async function checkedRoot(root: string): Promise<Fixture> {
    const loaded = await data();
    if (root !== loaded.info.root) {
      throw notFound(root);
    }
    return loaded;
  }

  async function commitFiles(root: string, sha: string): Promise<FileChange[]> {
    const files = (await checkedRoot(root)).commitFiles[sha];
    if (!files) {
      throw invalid(`no commit ${sha} in the fixture`);
    }
    return fresh(files);
  }

  return {
    initialRepoPath: async () => (await data()).info.root,
    pickFolder: async () => null,
    async openRepo(path) {
      const loaded = await data();
      if (path !== loaded.info.root) {
        throw notFound(path);
      }
      return fresh(loaded.info);
    },
    graphData: async (root) => fresh((await checkedRoot(root)).graph),
    commitFiles,
    async rangeFiles(root, shas) {
      const unique = [...new Set(shas)];
      if (unique.length === 0) {
        throw invalid("no commits selected");
      }
      if (unique.length === 1 && unique[0] !== undefined) {
        return commitFiles(root, unique[0]);
      }
      const files = (await checkedRoot(root)).rangeFiles[rangeKey(unique)];
      if (!files) {
        throw invalid("this selection is not in the fixture (add it in scripts/update-fixture.sh)");
      }
      return fresh(files);
    },
  };
}

async function loadDemoFixture(): Promise<Fixture> {
  const module = await import("../../fixtures/demo-repo.json");
  // The JSON is written from the same Rust types the bindings come from (CI checks both).
  return module.default as unknown as Fixture;
}

/**
 * The edge-case repository (`fixtures/edge-repo.json`): the demo repo plus
 * upstreams, an annotated tag, several tags on one commit, a remote-only
 * branch, a long branch name, renames, and a detached HEAD.
 */
export async function loadEdgeFixture(): Promise<Fixture> {
  const module = await import("../../fixtures/edge-repo.json");
  return module.default as unknown as Fixture;
}

function notFound(path: string): GitCommandError {
  return new GitCommandError({
    kind: "notARepository",
    message: `${path} is not inside a git repository`,
    path,
    root: null,
  });
}

function invalid(message: string): GitCommandError {
  return new GitCommandError({ kind: "invalidArgument", message, path: null, root: null });
}
