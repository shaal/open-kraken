import { describe, expect, it } from "vitest";
import { layoutGraph } from "../graph/lanes";
import { GitCommandError } from "./adapter";
import {
  createSyntheticAdapter,
  MAX_SYNTHETIC_COMMITS,
  syntheticCount,
  syntheticGraph,
} from "./syntheticAdapter";

describe("syntheticCount", () => {
  it("reads a whole number of commits from the query", () => {
    expect(syntheticCount("?synthetic=50000")).toBe(50_000);
    expect(syntheticCount("?x=1&synthetic=1")).toBe(1);
    expect(syntheticCount(`?synthetic=${MAX_SYNTHETIC_COMMITS}`)).toBe(MAX_SYNTHETIC_COMMITS);
  });

  it.each(["", "?other=5", "?synthetic", "?synthetic=", "?synthetic=0", "?synthetic=-5"])(
    "ignores %j",
    (search) => {
      expect(syntheticCount(search)).toBeNull();
    },
  );

  it.each(["?synthetic=1e5", "?synthetic=5.5", "?synthetic=05", "?synthetic= 5", "?synthetic=abc"])(
    "ignores the malformed %j",
    (search) => {
      expect(syntheticCount(search)).toBeNull();
    },
  );

  it("ignores the value unless it is given exactly once", () => {
    expect(syntheticCount("?synthetic=5&synthetic=abc")).toBeNull();
    expect(syntheticCount("?synthetic=abc&synthetic=5")).toBeNull();
    expect(syntheticCount("?synthetic=5&synthetic=5")).toBeNull();
  });

  it("ignores counts over the limit", () => {
    expect(syntheticCount(`?synthetic=${MAX_SYNTHETIC_COMMITS + 1}`)).toBeNull();
    expect(syntheticCount("?synthetic=99999999999")).toBeNull();
  });
});

describe("syntheticGraph", () => {
  const graph = syntheticGraph(5_000);
  const shas = new Set(graph.log.map((c) => c.sha));

  it("has exactly the commits asked for, each sha once, none of them git's null id", () => {
    expect(graph.log.length).toBe(5_000);
    expect(shas.size).toBe(5_000);
    expect(graph.log.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
    expect(shas.has("0".repeat(40))).toBe(false);
  });

  it("has refs like a real repository: main, origin/main, feature branches and tags", () => {
    const refs = graph.refs.refs;
    const names = refs.map((r) => r.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(refs.every((r) => shas.has(r.sha))).toBe(true);
    const head = graph.refs.head;
    const main = refs.find((r) => r.name === "refs/heads/main");
    expect(main).toMatchObject({
      kind: "localBranch",
      shortName: "main",
      upstream: "refs/remotes/origin/main",
      sha: head.sha,
    });
    const originMain = refs.find((r) => r.name === "refs/remotes/origin/main");
    expect(originMain).toMatchObject({
      kind: "remoteBranch",
      shortName: "origin/main",
      remote: "origin",
    });
    expect(originMain?.sha).not.toBe(main?.sha); // a few commits behind
    const features = refs.filter(
      (r) => r.kind === "localBranch" && r.shortName.startsWith("feature/"),
    );
    expect(features.length).toBeGreaterThan(0);
    expect(features.length).toBeLessThanOrEqual(8);
    for (const remote of refs.filter((r) => r.kind === "remoteBranch")) {
      const local = refs.find((r) => r.upstream === remote.name);
      expect(local?.sha).toBe(remote.name.endsWith("/main") ? main?.sha : remote.sha);
    }
    const tags = refs.filter((r) => r.kind === "tag");
    expect(tags.map((t) => t.shortName).slice(0, 3)).toEqual(["v0.0", "v0.1", "v0.2"]);
    expect(tags.some((t) => t.annotated)).toBe(true);
    expect(tags.some((t) => !t.annotated)).toBe(true);
    // The first tag is on the root commit.
    expect(tags.find((t) => t.shortName === "v0.0")?.sha).toBe(graph.log.at(-1)?.sha);
  });

  it("lists commits newest first, every parent present and older than its child", () => {
    const index = new Map(graph.log.map((c, i) => [c.sha, i]));
    graph.log.forEach((commit, i) => {
      if (i > 0) {
        expect(commit.committerTime).toBeLessThan(graph.log[i - 1]?.committerTime ?? Infinity);
      }
      for (const parent of commit.parents) {
        expect(index.get(parent)).toBeGreaterThan(i);
      }
    });
  });

  it("has one root, merges and branches", () => {
    expect(graph.log.filter((c) => c.parents.length === 0)).toHaveLength(1);
    expect(graph.log.filter((c) => c.parents.length === 2).length).toBeGreaterThan(50);
    const children = new Map<string, number>();
    for (const c of graph.log) {
      for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);
    }
    expect([...children.values()].filter((n) => n > 1).length).toBeGreaterThan(50);
  });

  it("points HEAD at main, whose first-parent line reaches the root", () => {
    const head = graph.refs.head;
    if (head.type !== "branch" || head.sha === null) throw new Error("HEAD is not on a branch");
    expect(head.shortName).toBe("main");
    expect(shas.has(head.sha)).toBe(true);
    const bySha = new Map(graph.log.map((c) => [c.sha, c]));
    let commit = bySha.get(head.sha);
    let steps = 0;
    while (commit && commit.parents.length > 0) {
      commit = bySha.get(commit.parents[0] ?? "");
      steps += 1;
    }
    expect(commit?.parents).toEqual([]);
    expect(steps).toBeGreaterThan(100);
  });

  it("is the same for the same seed, and different for another", () => {
    expect(syntheticGraph(5_000)).toEqual(graph);
    expect(syntheticGraph(5_000, 2)).not.toEqual(graph);
  });

  it("lays out with a bounded number of lanes", () => {
    const layout = layoutGraph(syntheticGraph(50_000).log);
    expect(layout.rows).toHaveLength(50_000);
    expect(layout.laneCount).toBeGreaterThan(1);
    expect(layout.laneCount).toBeLessThanOrEqual(10);
  });

  it("builds a single root commit for a count of 1", () => {
    const one = syntheticGraph(1);
    expect(one.log).toHaveLength(1);
    expect(one.log[0]?.parents).toEqual([]);
    expect(one.refs.head).toMatchObject({ type: "branch", sha: one.log[0]?.sha });
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_SYNTHETIC_COMMITS + 1])("rejects the count %d", (count) => {
    expect(() => syntheticGraph(count)).toThrow(RangeError);
    expect(() => createSyntheticAdapter(count)).toThrow(RangeError);
  });
});

describe("createSyntheticAdapter", () => {
  const adapter = createSyntheticAdapter(300);

  it("opens its own root and serves the history", async () => {
    expect(await adapter.initialRepoPath()).toBe("synthetic-300");
    const info = await adapter.openRepo("synthetic-300");
    expect(info).toEqual({
      root: "synthetic-300",
      gitDir: "synthetic-300/.git",
      bare: false,
      name: "synthetic-300",
    });
    expect((await adapter.graphData(info.root)).log).toHaveLength(300);
    expect(await adapter.pickFolder()).toBeNull();
  });

  it("returns new objects every call, like the real commands", async () => {
    const first = await adapter.graphData("synthetic-300");
    const second = await adapter.graphData("synthetic-300");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.log).not.toBe(first.log);
  });

  it("rejects other paths as not a repository", async () => {
    for (const call of [
      () => adapter.openRepo("/elsewhere"),
      () => adapter.graphData("/elsewhere"),
      () => adapter.commitFiles("/elsewhere", "a"),
      () => adapter.rangeFiles("/elsewhere", ["a", "b"]),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitCommandError);
      expect((error as GitCommandError).info.kind).toBe("notARepository");
    }
  });

  it("has no file changes, and rejects an empty selection or unknown commits", async () => {
    const log = (await adapter.graphData("synthetic-300")).log;
    const [newest, second] = [log[0]?.sha ?? "", log[1]?.sha ?? ""];
    expect(await adapter.commitFiles("synthetic-300", newest)).toEqual([]);
    expect(await adapter.rangeFiles("synthetic-300", [newest, second])).toEqual([]);
    for (const call of [
      () => adapter.rangeFiles("synthetic-300", []),
      () => adapter.commitFiles("synthetic-300", "0".repeat(40)),
      () => adapter.commitFiles("synthetic-300", (301).toString(16).padStart(40, "0")),
      () => adapter.commitFiles("synthetic-300", "xyz"),
      () => adapter.rangeFiles("synthetic-300", [newest, "f".repeat(40)]),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitCommandError);
      expect((error as GitCommandError).info.kind).toBe("invalidArgument");
    }
  });
});
