import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@tauri-apps/api/core");
  window.history.replaceState(null, "", "/");
});

async function adapterWhen(tauri: boolean, search = "") {
  window.history.replaceState(null, "", `/${search}`);
  expect(window.location.search).toBe(search);
  vi.doMock("@tauri-apps/api/core", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
    isTauri: () => tauri,
  }));
  const { defaultAdapter } = await import("./index");
  const { tauriAdapter } = await import("./tauriAdapter");
  return { adapter: defaultAdapter(), tauriAdapter };
}

describe("defaultAdapter", () => {
  it("uses the Tauri commands inside the app", async () => {
    const { adapter, tauriAdapter } = await adapterWhen(true);
    expect(adapter).toBe(tauriAdapter);
  });

  it("serves the demo fixture in a browser", async () => {
    const { adapter, tauriAdapter } = await adapterWhen(false);
    expect(adapter).not.toBe(tauriAdapter);
    expect(await adapter.initialRepoPath()).toBe("demo-repo");
  });

  it("serves a synthetic history when the URL asks for one", async () => {
    const { adapter } = await adapterWhen(false, "?synthetic=500");
    expect(await adapter.initialRepoPath()).toBe("synthetic-500");
    expect((await adapter.graphData("synthetic-500")).log).toHaveLength(500);
  });

  it("serves the demo fixture, with a warning, when the synthetic count is not valid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter } = await adapterWhen(false, "?synthetic=1e9");
    expect(await adapter.initialRepoPath()).toBe("demo-repo");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("?synthetic must be one whole number");
    warn.mockRestore();
  });

  it("ignores the synthetic query inside the app", async () => {
    const { adapter, tauriAdapter } = await adapterWhen(true, "?synthetic=500");
    expect(adapter).toBe(tauriAdapter);
  });
});
