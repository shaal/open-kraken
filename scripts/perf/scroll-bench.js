// Scroll benchmark for the commit graph, over the Chrome DevTools Protocol (Node 22+).
//
//   pnpm build && pnpm preview          # the production build, on port 4173
//   agent-browser set viewport 1280 800
//   agent-browser open "http://localhost:4173/?synthetic=50000"
//   node scripts/perf/scroll-bench.js "$(agent-browser get cdp-url)" [cpu slowdown, default 1]
//
// It sends real mouse-wheel events every 16 ms, so the browser scrolls as for a
// user: 140 px per event (a fast wheel) and 2800 px per event (about 100 rows,
// most of the view, per event). In the page it records, for each animation frame:
// - the time since the previous frame (performance.now(); the rAF timestamp
//   hides stalls in headless Chrome). A gap of 1.5 frame periods or more is a
//   late frame; the period is the median gap while idle.
// - whether every visible row is in the DOM (main-thread state at the frame;
//   the pixels themselves are not sampled).
// - long-animation-frame entries (50 ms or more) with what ran in them.
// It also reports the main-thread time per frame (Performance.getMetrics).
//
// Self-test first: stalls of 30, 30 and 60 ms and one jump of 5000 rows are
// injected, and the run stops unless all are seen (late frames, a long frame, a
// blank frame). Each wheel run stops unless the graph actually scrolled.

const [browserUrl, rateArg = "1", match = "?synthetic="] = process.argv.slice(2);
const rate = Number(rateArg);
if (!browserUrl || !(rate >= 1)) {
  console.error(
    "usage: node scripts/perf/scroll-bench.js <browser CDP url> [cpu slowdown >= 1] [page url part]",
  );
  process.exit(2);
}

/** Runs in the page: records frames for `durationMs`, optionally with the self-test faults. */
async function recordFrames({ durationMs, selfTest }) {
  const body = document.querySelector(".commit-graph-body");
  const table = document.querySelector("[role=table][aria-rowcount]");
  const firstRow = document.querySelector("[data-row-index]");
  if (!body || !table || !firstRow) throw new Error("no commit graph on this page");
  const rowCount = Number(table.getAttribute("aria-rowcount")) - 1;
  const rowHeight = firstRow.offsetHeight;
  body.scrollTop = 0;
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Frames of 50 ms or more, with what ran in them (Chrome's long-animation-frame entries).
  const longFrames = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longFrames.push({
        ms: Math.round(entry.duration),
        renderMs: Math.round(entry.startTime + entry.duration - entry.renderStart),
        scripts: entry.scripts.map(
          (script) =>
            `${script.invoker} ${script.sourceFunctionName || "?"} ${Math.round(script.duration)} ms`,
        ),
      });
    }
  });
  const longFramesSupported =
    PerformanceObserver.supportedEntryTypes.includes("long-animation-frame");
  if (longFramesSupported) observer.observe({ type: "long-animation-frame" });
  const stalls = new Map(
    selfTest
      ? [
          [30, 30],
          [60, 30],
          [90, 60],
        ]
      : [],
  ); // frame -> ms
  const gaps = [];
  let blankFrames = 0;
  let movedFrames = 0;
  let previousTop = body.scrollTop;
  let minRows = Infinity;
  let maxRows = 0;
  let frame = 0;
  let last = performance.now();
  const start = last;
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      frame += 1;
      const stallMs = stalls.get(frame) ?? 0;
      while (performance.now() - now < stallMs) {
        // busy: an injected stall
      }
      if (selfTest && frame === 45) body.scrollTop += 5000 * rowHeight; // rows cannot follow yet
      const rendered = new Set();
      for (const row of document.querySelectorAll("[data-row-index]")) {
        rendered.add(Number(row.dataset.rowIndex));
      }
      minRows = Math.min(minRows, rendered.size);
      maxRows = Math.max(maxRows, rendered.size);
      const top = body.scrollTop;
      if (top !== previousTop) movedFrames += 1;
      previousTop = top;
      const first = Math.floor(top / rowHeight);
      const lastVisible = Math.min(
        rowCount - 1,
        Math.floor((top + body.clientHeight - 1) / rowHeight),
      );
      for (let i = first; i <= lastVisible; i++) {
        if (!rendered.has(i)) {
          blankFrames += 1;
          break;
        }
      }
      if (now - start < durationMs) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  observer.disconnect();
  gaps.shift(); // from the start to the first frame
  return {
    gaps,
    blankFrames,
    movedFrames,
    domRows: [minRows, maxRows],
    scrollTop: body.scrollTop,
    maxScrollTop: body.scrollHeight - body.clientHeight,
    rowHeight,
    longFrames: longFramesSupported ? longFrames : null,
  };
}

const ws = new WebSocket(browserUrl);
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
};
const send = (method, params = {}, sessionId = undefined) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) =>
      message.error
        ? reject(new Error(`${method}: ${message.error.message}`))
        : resolve(message.result),
    );
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

const { targetInfos } = await send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page" && t.url.includes(match));
if (!page) throw new Error(`no open page has "${match}" in its URL`);
const { sessionId } = await send("Target.attachToTarget", {
  targetId: page.targetId,
  flatten: true,
});
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails)
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};
const taskSeconds = async () => {
  const { metrics } = await send("Performance.getMetrics", {}, sessionId);
  return metrics.find((m) => m.name === "TaskDuration")?.value ?? Number.NaN;
};

/** Records frames while wheel events of `deltaY` px go to the middle of the graph every 16 ms. */
async function measure(name, { durationMs, deltaY = 0, selfTest = false }) {
  const tasksBefore = await taskSeconds();
  const recording = evaluate(
    `(${recordFrames.toString()})(${JSON.stringify({ durationMs, selfTest })})`,
  );
  await new Promise((resolve) => setTimeout(resolve, 450)); // the recorder waits 300 ms first
  let wheelEvents = 0; // events the browser accepted
  let wheelErrors = 0;
  const wheel = deltaY
    ? setInterval(() => {
        send(
          "Input.dispatchMouseEvent",
          { type: "mouseWheel", x: center.x, y: center.y, deltaX: 0, deltaY },
          sessionId,
        ).then(
          () => (wheelEvents += 1),
          () => (wheelErrors += 1),
        );
      }, 16)
    : null;
  let result;
  try {
    result = await recording;
  } finally {
    if (wheel) clearInterval(wheel);
  }
  const mainThreadMs = ((await taskSeconds()) - tasksBefore) * 1000;
  if (deltaY) {
    // The wheel must really have scrolled the graph, or the run measured nothing.
    const expected = Math.min(wheelEvents * deltaY, result.maxScrollTop);
    if (wheelErrors > 0 || result.scrollTop < expected / 2) {
      throw new Error(
        `${name}: the graph scrolled to ${result.scrollTop} px after ${wheelEvents} wheel events ` +
          `(${wheelErrors} failed); expected about ${expected} px, so this run measured nothing`,
      );
    }
  }
  return { name, wheelEvents, mainThreadMs, ...result };
}

function summarize(run, period) {
  const sorted = [...run.gaps].sort((a, b) => a - b);
  const missed = run.gaps.map((gap) => Math.max(0, Math.round(gap / period) - 1));
  const round = (value) => Number(value.toFixed(1));
  return {
    run: run.name,
    frames: run.gaps.length,
    p50: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(sorted[Math.floor(sorted.length * 0.95)]),
    max: round(sorted.at(-1)),
    late: missed.filter((m) => m > 0).length, // frames that came 1.5 periods or more after the one before
    missed: missed.reduce((a, b) => a + b, 0), // display refreshes without a new frame
    blankFrames: run.blankFrames,
    domRows: run.domRows,
    scrollTop: run.scrollTop,
    movedFrames: run.movedFrames,
    rowsPerMovedFrame: run.movedFrames ? round(run.scrollTop / run.rowHeight / run.movedFrames) : 0,
    wheelEvents: run.wheelEvents,
    mainThreadMsPerFrame: round(run.mainThreadMs / run.gaps.length),
    longFrames: run.longFrames,
  };
}

let center;
try {
  const setup = await evaluate(`(() => {
    const body = document.querySelector(".commit-graph-body");
    const table = document.querySelector("[role=table][aria-rowcount]");
    if (!body || !table) return null;
    const r = body.getBoundingClientRect();
    return {
      viewport: innerWidth + "x" + innerHeight,
      rows: Number(table.getAttribute("aria-rowcount")) - 1,
      build: document.querySelector('script[src*="/@vite/client"]') ? "dev" : "production",
      center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
    };
  })()`);
  if (!setup) throw new Error(`${page.url} has no commit graph`);
  center = setup.center;
  await send("Performance.enable", {}, sessionId);

  const bench = `(() => { const t = performance.now(); let x = 0;
    for (let i = 0; i < 2e7; i++) x += i % 7; return performance.now() - t; })()`;
  const before = await evaluate(bench);
  // The slowdown lasts while this session is attached, so everything runs here.
  await send("Emulation.setCPUThrottlingRate", { rate }, sessionId);
  const slowdown = (await evaluate(bench)) / before;
  console.log(
    JSON.stringify({ page: page.url, ...setup, cpuSlowdown: Number(slowdown.toFixed(2)) }),
  );

  const idle = await measure("idle", { durationMs: 2000 });
  const period = [...idle.gaps].sort((a, b) => a - b)[Math.floor(idle.gaps.length / 2)];
  const selfTest = summarize(
    await measure("self-test: stalls of 30, 30 and 60 ms, a 5000-row jump", {
      durationMs: 2000,
      selfTest: true,
    }),
    period,
  );
  console.log(JSON.stringify(selfTest));
  const blind = [
    selfTest.late < 3 && "late frames",
    selfTest.blankFrames < 1 && "blank rows",
    selfTest.longFrames !== null && selfTest.longFrames.length < 1 && "long frames",
  ].filter(Boolean);
  if (blind.length > 0) {
    throw new Error(
      `the instrument did not see the injected ${blind.join(", ")}; its numbers mean nothing`,
    );
  }
  console.log(JSON.stringify(summarize(idle, period)));
  for (const [name, deltaY] of [
    ["wheel 140 px per event", 140],
    ["wheel 2800 px per event", 2800],
  ]) {
    console.log(
      JSON.stringify(summarize(await measure(name, { durationMs: 5000, deltaY }), period)),
    );
  }
} finally {
  await send("Emulation.setCPUThrottlingRate", { rate: 1 }, sessionId).catch(() => {});
  ws.close();
}
