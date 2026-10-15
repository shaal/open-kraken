import { GitCommandError, type GitAdapter } from "./adapter";
import type { Commit } from "./bindings/Commit";
import type { GraphData } from "./bindings/GraphData";
import type { Ref } from "./bindings/Ref";
import type { RepoInfo } from "./bindings/RepoInfo";

/**
 * The largest synthetic history accepted. Its rows are 28 000 000 px tall,
 * which Chrome scrolls to the end; other engines may allow less height.
 */
export const MAX_SYNTHETIC_COMMITS = 1_000_000;

/**
 * The commit count asked for with `?synthetic=<count>`, or null unless the
 * query has exactly one such value, a whole number from 1 to MAX_SYNTHETIC_COMMITS.
 */
export function syntheticCount(search: string): number | null {
  const values = new URLSearchParams(search).getAll("synthetic");
  const value = values.length === 1 ? values[0] : undefined;
  if (value === undefined || !/^[1-9][0-9]{0,6}$/.test(value)) return null;
  const count = Number(value);
  return count <= MAX_SYNTHETIC_COMMITS ? count : null;
}

function checkCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SYNTHETIC_COMMITS) {
    throw new RangeError(`synthetic commit count must be 1 to ${MAX_SYNTHETIC_COMMITS}`);
  }
}

/** A 40-hex sha for synthetic commit `n` (from 1: all zeros is git's null id). */
function sha(n: number): string {
  return (n + 1).toString(16).padStart(40, "0");
}

/** Whether `value` is the sha of a commit in a synthetic history of `count` commits. */
function isSyntheticSha(value: string, count: number): boolean {
  if (!/^[0-9a-f]{40}$/.test(value)) return false;
  const n = Number.parseInt(value, 16);
  return n >= 1 && n <= count;
}

/** A small deterministic PRNG (mulberry32), so every run builds the same history. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic history of `count` commits for performance work in the browser
 * (`?synthetic=50000`): a main line with up to 8 feature branches open at a
 * time, each 2–30 commits long and merged back into main when done. The same
 * count and seed always give the same history.
 *
 * Refs: `main` (checked out, tracking `origin/main`, which is a few commits
 * behind), a `feature/<id>` branch at each branch still open at the end (every
 * third one also pushed to `origin`), and a tag on every 500th main commit
 * (every other tag annotated). Merged branches have no refs, as after a cleanup.
 */
export function syntheticGraph(count: number, seed = 1): GraphData {
  checkCount(count);
  const rand = random(seed);
  const log: Commit[] = [];
  const open: { id: number; tip: number; left: number }[] = [];
  const tags: Ref[] = [];
  let nextBranchId = 1;
  let main = 0;
  let mainCommits = 0;
  const recentMain: number[] = []; // the last few main tips, newest last
  const advanceMain = (n: number) => {
    main = n;
    mainCommits += 1;
    recentMain.push(n);
    if (recentMain.length > 4) recentMain.shift();
    if (mainCommits % 500 === 1) {
      const k = (mainCommits - 1) / 500;
      tags.push(tagRef(`v${Math.floor(k / 10)}.${k % 10}`, sha(n), k % 2 === 1));
    }
  };
  for (let n = 0; n < count; n++) {
    let parents: string[];
    const roll = rand();
    if (n === 0) {
      parents = []; // the root commit
      advanceMain(n);
    } else if (open.length > 0 && roll < 0.35) {
      // Work on an open branch; merge it back into main when it is done.
      const i = Math.floor(rand() * open.length);
      const branch = open[i];
      if (!branch) throw new Error("unreachable: branch index out of range");
      if (branch.left <= 0) {
        parents = [sha(main), sha(branch.tip)];
        advanceMain(n);
        open.splice(i, 1);
      } else {
        parents = [sha(branch.tip)];
        branch.tip = n;
        branch.left -= 1;
      }
    } else if (roll < 0.45 && open.length < 8) {
      parents = [sha(main)]; // start a branch off main
      open.push({ id: nextBranchId++, tip: n, left: 1 + Math.floor(rand() * 29) });
    } else {
      parents = [sha(main)];
      advanceMain(n);
    }
    const author = n % 7;
    log.push({
      sha: sha(n),
      parents,
      authorName: `Developer ${author}`,
      authorEmail: `dev${author}@example.com`,
      authorTime: 1_600_000_000 + n * 60,
      authorTzOffset: 0,
      committerTime: 1_600_000_000 + n * 60,
      subject: `Synthetic commit ${n}`,
    });
  }
  log.reverse(); // newest first, like git log

  const refs: Ref[] = [
    branchRef("main", sha(main), "refs/remotes/origin/main"),
    remoteRef("main", sha(recentMain[0] ?? main)),
    ...tags,
  ];
  for (const branch of open) {
    const name = `feature/${branch.id}`;
    const pushed = branch.id % 3 === 0;
    refs.push(branchRef(name, sha(branch.tip), pushed ? `refs/remotes/origin/${name}` : null));
    if (pushed) refs.push(remoteRef(name, sha(branch.tip)));
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    log,
    refs: {
      head: { type: "branch", name: "refs/heads/main", shortName: "main", sha: sha(main) },
      refs,
    },
    status: { staged: [], unstaged: [], conflicted: [], skipped: null },
    stashes: [],
  };
}

function branchRef(shortName: string, sha: string, upstream: string | null): Ref {
  return {
    name: `refs/heads/${shortName}`,
    shortName,
    kind: "localBranch",
    remote: null,
    sha,
    annotated: false,
    upstream,
  };
}

function remoteRef(branch: string, sha: string): Ref {
  return {
    name: `refs/remotes/origin/${branch}`,
    shortName: `origin/${branch}`,
    kind: "remoteBranch",
    remote: "origin",
    sha,
    annotated: false,
    upstream: null,
  };
}

function tagRef(shortName: string, sha: string, annotated: boolean): Ref {
  const name = `refs/tags/${shortName}`;
  return { name, shortName, kind: "tag", remote: null, sha, annotated, upstream: null };
}

/**
 * Serves a synthetic history; the default adapter in a browser opened with
 * `?synthetic=<count>`. Like the real commands, every call returns new objects.
 */
export function createSyntheticAdapter(count: number): GitAdapter {
  checkCount(count);
  const root = `synthetic-${count}`;
  const check = (path: string) => {
    if (path !== root) {
      throw new GitCommandError({
        kind: "notARepository",
        message: `${path} is not inside a git repository`,
        path,
        root: null,
      });
    }
  };
  const invalid = (message: string) =>
    new GitCommandError({ kind: "invalidArgument", message, path: null, root: null });
  const checkSha = (value: string) => {
    if (!isSyntheticSha(value, count)) throw invalid(`no commit ${value} in ${root}`);
  };
  return {
    initialRepoPath: async () => root,
    pickFolder: async () => null,
    async openRepo(path) {
      check(path);
      return { root, gitDir: `${root}/.git`, bare: false, name: root } satisfies RepoInfo;
    },
    async graphData(path) {
      check(path);
      return syntheticGraph(count);
    },
    // Synthetic commits change no files.
    async commitFiles(path, commit) {
      check(path);
      checkSha(commit);
      return [];
    },
    async rangeFiles(path, shas) {
      check(path);
      if (shas.length === 0) throw invalid("no commits selected");
      shas.forEach(checkSha);
      return [];
    },
  };
}
