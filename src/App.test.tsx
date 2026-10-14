import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { GitCommandError, type GitAdapter } from "./git";
import { createFixtureAdapter } from "./git/fixtureAdapter";

function fakeAdapter(overrides: Partial<GitAdapter>): GitAdapter {
  const fixture = createFixtureAdapter();
  return { ...fixture, initialRepoPath: async () => null, ...overrides };
}

describe("App", () => {
  it("shows the app name as the main heading", () => {
    render(<App adapter={fakeAdapter({})} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("open-kraken");
  });

  it("opens the demo repo from the fixture and summarizes it", async () => {
    render(<App adapter={createFixtureAdapter()} />);
    expect(await screen.findByRole("heading", { level: 2, name: "demo-repo" })).toBeTruthy();
    expect(screen.getByTestId("commit-count").textContent).toBe("19 commits");
    const facts = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(facts).toEqual([
      "19 commits",
      "5 branches",
      "3 remote branches",
      "2 tags",
      "1 stash",
      "2 changed files",
    ]);
    expect(screen.getByTestId("load-time").textContent).toMatch(/^Loaded in \d+ ms$/);
  });

  it("starts idle without a command-line repo, and opens a picked folder", async () => {
    const pickFolder = vi.fn(async () => "demo-repo");
    render(<App adapter={fakeAdapter({ pickFolder })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open repository…" }));
    expect(await screen.findByTestId("commit-count")).toBeTruthy();
    expect(pickFolder).toHaveBeenCalledTimes(1);
  });

  it("stays idle when the folder picker is cancelled", async () => {
    render(<App adapter={fakeAdapter({ pickFolder: async () => null })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open repository…" }));
    });
    expect(screen.getByRole("button", { name: "Open repository…" })).toBeTruthy();
  });

  it("offers to open the root when a subfolder was chosen", async () => {
    const fixture = createFixtureAdapter();
    const openRepo = vi.fn(async (path: string) => {
      if (path === "/r/sub") {
        throw new GitCommandError({
          kind: "notRepositoryRoot",
          message: "/r/sub is inside the repository at demo-repo; open that folder instead",
          path: "/r/sub",
          root: "demo-repo",
        });
      }
      return fixture.openRepo(path);
    });
    render(<App adapter={fakeAdapter({ initialRepoPath: async () => "/r/sub", openRepo })} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("open that folder instead");
    fireEvent.click(screen.getByRole("button", { name: "Open demo-repo" }));
    expect(await screen.findByTestId("commit-count")).toBeTruthy();
    expect(openRepo).toHaveBeenLastCalledWith("demo-repo");
  });

  it("shows other errors without an open-root button", async () => {
    const openRepo = async () => {
      throw new GitCommandError({
        kind: "notARepository",
        message: "/x is not inside a git repository",
        path: "/x",
        root: null,
      });
    };
    render(<App adapter={fakeAdapter({ initialRepoPath: async () => "/x", openRepo })} />);
    expect((await screen.findByRole("alert")).textContent).toContain("not inside a git repository");
    expect(screen.queryByRole("button", { name: /^Open \// })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose another folder…" })).toBeTruthy();
  });

  it("shows an error when the folder picker fails", async () => {
    const pickFolder = async () => {
      throw new GitCommandError({
        kind: "internal",
        message: "dialog broke",
        path: null,
        root: null,
      });
    };
    render(<App adapter={fakeAdapter({ pickFolder })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open repository…" }));
    expect((await screen.findByRole("alert")).textContent).toContain("dialog broke");
  });

  it("shows an error when the command-line path cannot be read", async () => {
    const initialRepoPath = async () => {
      throw new Error("ipc down");
    };
    render(<App adapter={fakeAdapter({ initialRepoPath })} />);
    expect((await screen.findByRole("alert")).textContent).toContain("ipc down");
  });

  it("ignores a slow earlier open once a newer one finished", async () => {
    const fixture = createFixtureAdapter();
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const openRepo = vi.fn(async (path: string) => {
      if (path === "/slow") {
        await slowGate;
        return { root: "demo-repo", gitDir: "x", bare: false, name: "slow repo" };
      }
      return fixture.openRepo(path);
    });
    render(
      <App
        adapter={fakeAdapter({
          initialRepoPath: async () => "/slow",
          openRepo,
          pickFolder: async () => "demo-repo",
        })}
      />,
    );
    // While /slow is loading, open the demo repo instead.
    fireEvent.click(await screen.findByRole("button", { name: "Open another repository…" }));
    expect(await screen.findByRole("heading", { level: 2, name: "demo-repo" })).toBeTruthy();
    // The slow open finishes last; its result must not replace the newer one.
    await act(async () => {
      releaseSlow();
      await slowGate;
    });
    expect(screen.queryByRole("heading", { name: "slow repo" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("demo-repo");
    expect(openRepo.mock.calls.map((c) => c[0])).toEqual(["/slow", "demo-repo"]);
  });

  it("moves focus to the repository heading after it opens", async () => {
    render(<App adapter={createFixtureAdapter()} />);
    const heading = await screen.findByRole("heading", { level: 2, name: "demo-repo" });
    expect(document.activeElement).toBe(heading);
  });

  it("lets a folder the user picked win over a late command-line path", async () => {
    let releasePath: (path: string) => void = () => {};
    const latePath = new Promise<string>((resolve) => {
      releasePath = resolve;
    });
    const fixture = createFixtureAdapter();
    const openRepo = vi.fn((path: string) => fixture.openRepo(path));
    render(
      <App
        adapter={fakeAdapter({
          initialRepoPath: () => latePath,
          openRepo,
          pickFolder: async () => "demo-repo",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open repository…" }));
    expect(await screen.findByRole("heading", { level: 2, name: "demo-repo" })).toBeTruthy();
    await act(async () => {
      releasePath("/from/command/line");
      await latePath;
    });
    expect(openRepo.mock.calls.map((c) => c[0])).toEqual(["demo-repo"]);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("demo-repo");
  });

  it("keeps a picker error when an older load finishes later", async () => {
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowDone: () => void = () => {};
    const slowFinished = new Promise<void>((resolve) => {
      slowDone = resolve;
    });
    const fixture = createFixtureAdapter();
    const openRepo = async (path: string) => {
      if (path === "/slow") await slowGate;
      return fixture.openRepo("demo-repo");
    };
    const graphData = async (root: string) => {
      const graph = await fixture.graphData(root);
      setTimeout(slowDone, 0); // after the app has received the result
      return graph;
    };
    const pickFolder = async (): Promise<string | null> => {
      throw new GitCommandError({
        kind: "internal",
        message: "dialog broke",
        path: null,
        root: null,
      });
    };
    render(
      <App
        adapter={fakeAdapter({
          initialRepoPath: async () => "/slow",
          openRepo,
          graphData,
          pickFolder,
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open another repository…" }));
    expect((await screen.findByRole("alert")).textContent).toContain("dialog broke");
    await act(async () => {
      releaseSlow();
      await slowFinished;
    });
    expect(screen.getByRole("alert").textContent).toContain("dialog broke");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("says when the working tree was not read", async () => {
    const fixture = createFixtureAdapter();
    const graphData = async (root: string) => {
      const graph = await fixture.graphData(root);
      return {
        ...graph,
        status: {
          staged: [],
          unstaged: [],
          conflicted: [],
          skipped: "this repository's own config defines filter programs (evil)",
        },
      };
    };
    render(<App adapter={fakeAdapter({ initialRepoPath: async () => "demo-repo", graphData })} />);
    expect((await screen.findByTestId("status-skipped")).textContent).toContain("(evil)");
    expect(screen.getAllByRole("listitem").at(-1)?.textContent).toBe("changes not read");
  });
});
