import type { GraphContext } from "../graph/drawGraph";

/** One recorded canvas call: its name, its arguments, and the styles in effect. */
export interface Call {
  name: string;
  args: number[];
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
}

/** A canvas context for tests: it draws nothing and records every call. */
export class RecordingContext implements GraphContext {
  strokeStyle: unknown = "";
  fillStyle: unknown = "";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  calls: Call[] = [];

  private record(name: string, args: number[]) {
    this.calls.push({
      name,
      args,
      strokeStyle: this.strokeStyle,
      fillStyle: this.fillStyle,
      lineWidth: this.lineWidth,
    });
  }

  named(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  setTransform(...args: number[]) {
    this.record("setTransform", args);
  }
  clearRect(...args: [number, number, number, number]) {
    this.record("clearRect", args);
  }
  fillRect(...args: [number, number, number, number]) {
    this.record("fillRect", args);
  }
  beginPath() {
    this.record("beginPath", []);
  }
  moveTo(...args: [number, number]) {
    this.record("moveTo", args);
  }
  lineTo(...args: [number, number]) {
    this.record("lineTo", args);
  }
  arcTo(...args: [number, number, number, number, number]) {
    this.record("arcTo", args);
  }
  arc(...args: [number, number, number, number, number]) {
    this.record("arc", args);
  }
  stroke() {
    this.record("stroke", []);
  }
  fill() {
    this.record("fill", []);
  }
}
