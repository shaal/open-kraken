import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@tauri-apps/api/core");
});

async function adapterWhen(tauri: boolean) {
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
});
