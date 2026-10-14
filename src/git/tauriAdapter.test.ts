import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandError } from "./adapter";
import { tauriAdapter } from "./tauriAdapter";

afterEach(() => {
  clearMocks();
});

describe("tauri adapter", () => {
  it("calls the Rust commands with their arguments", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "initial_repo_path") return "/repos/a";
      if (cmd === "open_repo")
        return { root: "/repos/a", gitDir: "/repos/a/.git", bare: false, name: "a" };
      return [];
    });
    expect(await tauriAdapter.initialRepoPath()).toBe("/repos/a");
    expect((await tauriAdapter.openRepo("/repos/a")).name).toBe("a");
    await tauriAdapter.commitFiles("/repos/a", "abc");
    await tauriAdapter.rangeFiles("/repos/a", ["x", "y"]);
    await tauriAdapter.graphData("/repos/a");
    expect(calls).toEqual([
      ["initial_repo_path", {}],
      ["open_repo", { path: "/repos/a" }],
      ["commit_files", { root: "/repos/a", sha: "abc" }],
      ["range_files", { root: "/repos/a", shas: ["x", "y"] }],
      ["graph_data", { root: "/repos/a" }],
    ]);
  });

  it("turns command errors into GitCommandError", async () => {
    mockIPC(() => {
      throw { kind: "notRepositoryRoot", message: "inside", path: "/r/sub", root: "/r" };
    });
    await expect(tauriAdapter.openRepo("/r/sub")).rejects.toBeInstanceOf(GitCommandError);
    await expect(tauriAdapter.openRepo("/r/sub")).rejects.toMatchObject({
      info: { kind: "notRepositoryRoot", root: "/r" },
    });
  });

  it("asks the dialog plugin for one folder", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return "/picked/folder";
    });
    expect(await tauriAdapter.pickFolder()).toBe("/picked/folder");
    expect(calls[0]?.[0]).toBe("plugin:dialog|open");
    expect(calls[0]?.[1]).toMatchObject({ options: { directory: true, multiple: false } });
  });

  it("treats a cancelled dialog as no folder", async () => {
    mockIPC(() => null);
    expect(await tauriAdapter.pickFolder()).toBeNull();
  });
});
