import { isTauri } from "@tauri-apps/api/core";
import type { GitAdapter } from "./adapter";
import { createFixtureAdapter } from "./fixtureAdapter";
import { createSyntheticAdapter, MAX_SYNTHETIC_COMMITS, syntheticCount } from "./syntheticAdapter";
import { tauriAdapter } from "./tauriAdapter";

export { GitCommandError, type GitAdapter } from "./adapter";

/**
 * The Tauri adapter in the desktop app. In a plain browser: a synthetic history
 * when the URL asks for one (`?synthetic=50000`), else the demo fixture.
 */
export function defaultAdapter(): GitAdapter {
  if (isTauri()) return tauriAdapter;
  const search = window.location.search;
  const count = syntheticCount(search);
  if (count === null && new URLSearchParams(search).has("synthetic")) {
    console.warn(
      `?synthetic must be one whole number from 1 to ${MAX_SYNTHETIC_COMMITS}; showing the demo`,
    );
  }
  return count === null ? createFixtureAdapter() : createSyntheticAdapter(count);
}
