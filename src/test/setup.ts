import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { RecordingContext } from "./recordingContext";

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

// jsdom has no canvas. Give every canvas a RecordingContext, so the graph is
// really drawn in tests; tests that check the drawing spy on getContext.
HTMLCanvasElement.prototype.getContext = function getContext() {
  return new RecordingContext() as unknown as CanvasRenderingContext2D;
} as unknown as typeof HTMLCanvasElement.prototype.getContext;
