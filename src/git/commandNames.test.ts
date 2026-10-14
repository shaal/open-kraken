import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Vitest runs from the repository root.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("the Tauri adapter only calls commands the app registers", () => {
  it("matches generate_handler! in src-tauri/src/lib.rs", () => {
    const adapter = read("src/git/tauriAdapter.ts");
    const called = [...adapter.matchAll(/call<[^>]+>\("([a-z_]+)"/g)].map((m) => m[1]);
    const lib = read("src-tauri/src/lib.rs");
    const handler = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? "";
    const registered = [...handler.matchAll(/commands::([a-z_]+)/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(0);
    expect([...called].sort()).toEqual([...registered].sort());
  });
});
