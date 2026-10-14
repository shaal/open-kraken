import { isTauri } from "@tauri-apps/api/core";

/**
 * Writes a line to the app log (stdout and the log folder) in the desktop app,
 * or to the console in a browser.
 */
export function logInfo(message: string): void {
  if (isTauri()) {
    void import("@tauri-apps/plugin-log").then(({ info }) => info(message));
  } else {
    console.info(message);
  }
}

export function logError(message: string): void {
  if (isTauri()) {
    void import("@tauri-apps/plugin-log").then(({ error }) => error(message));
  } else {
    console.error(message);
  }
}
