import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("./graph/CommitGraph");
  vi.resetModules();
});

function Broken(): never {
  throw new Error("lanes exploded");
}

describe("ErrorBoundary", () => {
  it("shows its children when they render", () => {
    render(
      <ErrorBoundary action="draw the commit graph">
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows and logs the error instead of a blank window when a child throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary action="draw the commit graph">
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not draw the commit graph: lanes exploded",
    );
    expect(consoleError).toHaveBeenCalledWith("could not draw the commit graph: lanes exploded");
  });

  it("keeps the repository summary when the commit graph fails to draw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("./graph/CommitGraph", () => ({ CommitGraph: Broken }));
    const { App } = await import("./App");
    const { createFixtureAdapter } = await import("./git/fixtureAdapter");
    render(<App adapter={createFixtureAdapter()} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not draw the commit graph: lanes exploded",
    );
    expect(screen.getByRole("heading", { level: 2, name: "demo-repo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open another repository…" })).toBeTruthy();
  });
});
