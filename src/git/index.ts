import { isTauri } from "@tauri-apps/api/core";
import type { GitAdapter } from "./adapter";
import { createFixtureAdapter, loadEdgeFixture } from "./fixtureAdapter";
import { createSyntheticAdapter, MAX_SYNTHETIC_COMMITS, syntheticCount } from "./syntheticAdapter";
import { tauriAdapter } from "./tauriAdapter";

export { GitCommandError, type GitAdapter } from "./adapter";

/**
 * The Tauri adapter in the desktop app. In a plain browser: a synthetic history
 * when the URL asks for one (`?synthetic=50000`), the edge-case fixture for
 * `?fixture=edge`, else the demo fixture.
 */
export function defaultAdapter(): GitAdapter {
  if (isTauri()) return tauriAdapter;
  const search = window.location.search;
  const params = new URLSearchParams(search);
  const count = syntheticCount(search);
  if (count !== null) return createSyntheticAdapter(count);
  if (params.has("synthetic")) {
    console.warn(
      `?synthetic must be one whole number from 1 to ${MAX_SYNTHETIC_COMMITS}; ignoring it`,
    );
  }
  const fixture = params.getAll("fixture");
  if (fixture.length === 1 && fixture[0] === "edge") return createFixtureAdapter(loadEdgeFixture);
  if (fixture.length > 0) console.warn("?fixture must be edge; showing the demo");
  return createFixtureAdapter();
}
