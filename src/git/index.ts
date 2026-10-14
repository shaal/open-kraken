import { isTauri } from "@tauri-apps/api/core";
import type { GitAdapter } from "./adapter";
import { createFixtureAdapter } from "./fixtureAdapter";
import { tauriAdapter } from "./tauriAdapter";

export { GitCommandError, type GitAdapter } from "./adapter";

/** The Tauri adapter in the desktop app; the demo fixture in a plain browser. */
export function defaultAdapter(): GitAdapter {
  return isTauri() ? tauriAdapter : createFixtureAdapter();
}
