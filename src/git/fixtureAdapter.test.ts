import { describe, expect, it } from "vitest";
import { GitCommandError } from "./adapter";
import { createFixtureAdapter } from "./fixtureAdapter";

const MAIN = "35883939c0918f6444fc665a61ab7484048769c3";

async function rejection(promise: Promise<unknown>): Promise<GitCommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitCommandError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("fixture adapter (fixtures/demo-repo.json)", () => {
  const git = createFixtureAdapter();

  it("opens the demo repo", async () => {
    const path = await git.initialRepoPath();
    expect(path).toBe("demo-repo");
    const info = await git.openRepo("demo-repo");
    expect(info).toEqual({
      root: "demo-repo",
      gitDir: "demo-repo/.git",
      bare: false,
      name: "demo-repo",
    });
    expect(await git.pickFolder()).toBeNull();
  });

  it("serves the demo repo's graph data", async () => {
    const graph = await git.graphData("demo-repo");
    expect(graph.log).toHaveLength(19);
    expect(graph.refs.head).toEqual({
      type: "branch",
      name: "refs/heads/main",
      shortName: "main",
      sha: MAIN,
    });
    expect(graph.refs.refs.map((r) => r.shortName)).toContain("origin/main");
    expect(graph.stashes).toHaveLength(1);
    expect(graph.status.unstaged.map((f) => f.path)).toEqual(["README.md", "notes.txt"]);
  });

  it("serves file lists for single commits and the observed selections", async () => {
    const graph = await git.graphData("demo-repo");
    const sha = (subject: string) => {
      const commit = graph.log.find((c) => c.subject === subject);
      if (!commit) throw new Error(subject);
      return commit.sha;
    };
    expect(await git.commitFiles("demo-repo", sha("Add context menu on commits"))).toEqual([
      { path: "graph.js", oldPath: null, kind: "modified" },
    ]);
    const three = ["Add context menu on commits", "Scaffold graph view", "Draw commit lanes"].map(
      sha,
    );
    expect(await git.rangeFiles("demo-repo", three)).toEqual([
      { path: "graph.js", oldPath: null, kind: "added" },
    ]);
    expect(
      await git.rangeFiles("demo-repo", [sha("Add login form"), sha("Fix typo in docs")]),
    ).toEqual([
      { path: "docs.md", oldPath: null, kind: "added" },
      { path: "login.js", oldPath: null, kind: "deleted" },
    ]);
    const one = sha("Add login form");
    expect(await git.rangeFiles("demo-repo", [one, one])).toEqual(
      await git.commitFiles("demo-repo", one),
    );
  });

  it("rejects what the fixture does not have", async () => {
    expect((await rejection(git.openRepo("/somewhere/else"))).info.kind).toBe("notARepository");
    expect((await rejection(git.graphData("other"))).info.kind).toBe("notARepository");
    expect((await rejection(git.commitFiles("demo-repo", "0".repeat(40)))).info.kind).toBe(
      "invalidArgument",
    );
    expect((await rejection(git.rangeFiles("demo-repo", []))).info.kind).toBe("invalidArgument");
    const graph = await git.graphData("demo-repo");
    const [a, b] = graph.log;
    expect(
      (await rejection(git.rangeFiles("demo-repo", [a?.sha ?? "", b?.sha ?? ""]))).info.kind,
    ).toBe("invalidArgument");
  });

  it("loads the fixture once", async () => {
    let loads = 0;
    const counting = createFixtureAdapter(async () => {
      loads += 1;
      const real = createFixtureAdapter();
      const info = await real.openRepo("demo-repo");
      return { info, graph: await real.graphData("demo-repo"), commitFiles: {}, rangeFiles: {} };
    });
    await counting.openRepo("demo-repo");
    await counting.graphData("demo-repo");
    expect(loads).toBe(1);
  });
});
