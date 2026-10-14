/// <reference types="vitest/config" />
import process from "node:process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Options for `tauri dev` and `tauri build`:
  // 1. keep Rust errors visible,
  clearScreen: false,
  // 2. use the fixed port that tauri.conf.json expects, and fail if it is taken,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // 3. do not watch the Rust side.
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },

  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    // Default include (any *.test/*.spec file); keep build output and the Rust side out.
    exclude: ["**/node_modules/**", "**/dist/**", "**/target/**", "src-tauri/**", "crates/**"],
  },
});
