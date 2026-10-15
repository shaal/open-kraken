import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultAdapter, type GitAdapter } from "./git";
import { toGitCommandError } from "./git/adapter";
import type { Commit } from "./git/bindings/Commit";
import type { ErrorInfo } from "./git/bindings/ErrorInfo";
import type { GraphData } from "./git/bindings/GraphData";
import type { RefKind } from "./git/bindings/RefKind";
import type { RepoInfo } from "./git/bindings/RepoInfo";
import { ErrorBoundary } from "./ErrorBoundary";
import { CommitGraph } from "./graph/CommitGraph";
import { layoutGraph, type GraphLayout } from "./graph/lanes";
import { buildRefLabels, type RefLabels } from "./graph/refLabels";
import { logError, logInfo } from "./log";

type RepoState =
  | { phase: "idle" }
  | { phase: "loading"; path: string }
  | {
      phase: "loaded";
      /** Which open this is: a new one remounts the view (scroll position, errors). */
      loadId: number;
      info: RepoInfo;
      graph: GraphData;
      layout: GraphLayout<Commit>;
      labels: RefLabels;
      loadMs: number;
    }
  | { phase: "error"; path: string; error: ErrorInfo };

export function App({ adapter }: { adapter?: GitAdapter }) {
  const git = useMemo(() => adapter ?? defaultAdapter(), [adapter]);
  const [state, setState] = useState<RepoState>({ phase: "idle" });
  // Only the newest open request may update the state: a slow earlier one is dropped.
  const latestRequest = useRef(0);

  const fail = useCallback((path: string, error: unknown) => {
    const info = toGitCommandError(error).info;
    setState({ phase: "error", path, error: info });
    logError(`could not open ${path}: ${info.kind}: ${info.message}`);
  }, []);

  const openPath = useCallback(
    async (path: string) => {
      const request = ++latestRequest.current;
      setState({ phase: "loading", path });
      const started = performance.now();
      try {
        const info = await git.openRepo(path);
        const graph = await git.graphData(info.root);
        if (request !== latestRequest.current) return;
        const layoutStarted = performance.now();
        const layout = layoutGraph(graph.log);
        // Built once per load, so its identity is stable and rows stay memoized.
        const labels = buildRefLabels(graph.refs, graph.log);
        const loadMs = performance.now() - started; // reading and layout
        const layoutMs = performance.now() - layoutStarted;
        setState({ phase: "loaded", loadId: request, info, graph, layout, labels, loadMs });
        logInfo(
          `opened ${info.root}: ${graph.log.length} commits in ${Math.round(loadMs)} ms ` +
            `(layout ${Math.round(layoutMs)} ms)`,
        );
      } catch (error) {
        if (request !== latestRequest.current) return;
        fail(path, error);
      }
    },
    [git, fail],
  );

  const chooseFolder = useCallback(async () => {
    let picked: string | null;
    try {
      picked = await git.pickFolder();
    } catch (error) {
      latestRequest.current += 1; // an older load still running must not replace this error
      fail("the chosen folder", error);
      return;
    }
    if (picked) {
      await openPath(picked);
    }
  }, [git, openPath, fail]);

  useEffect(() => {
    let cancelled = false;
    git.initialRepoPath().then(
      (path) => {
        // If the user already opened something, their choice wins.
        if (path && !cancelled && latestRequest.current === 0) {
          void openPath(path);
        }
      },
      (error: unknown) => {
        if (!cancelled && latestRequest.current === 0) {
          fail("the command-line repository", error);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [git, openPath, fail]);

  return (
    <main className="app">
      <h1>open-kraken</h1>
      {state.phase === "idle" && (
        <section>
          <p>Git client with an interactive commit graph.</p>
          <button type="button" onClick={() => void chooseFolder()}>
            Open repository…
          </button>
        </section>
      )}
      {state.phase === "loading" && (
        <section>
          <p role="status">Opening {state.path}…</p>
          <button type="button" onClick={() => void chooseFolder()}>
            Open another repository…
          </button>
        </section>
      )}
      {state.phase === "loaded" && (
        <RepoView
          key={state.loadId}
          info={state.info}
          graph={state.graph}
          layout={state.layout}
          labels={state.labels}
          loadMs={state.loadMs}
          onOpenAnother={() => void chooseFolder()}
        />
      )}
      {state.phase === "error" && (
        <section role="alert" className="error">
          <p>{state.error.message}</p>
          {state.error.kind === "notRepositoryRoot" && state.error.root && (
            <button type="button" onClick={() => void openPath(state.error.root ?? "")}>
              Open {state.error.root}
            </button>
          )}
          <button type="button" onClick={() => void chooseFolder()}>
            Choose another folder…
          </button>
        </section>
      )}
    </main>
  );
}

interface RepoViewProps {
  info: RepoInfo;
  graph: GraphData;
  layout: GraphLayout<Commit>;
  labels: RefLabels;
  loadMs: number;
  onOpenAnother: () => void;
}

/** An open repository: a short summary above the commit graph. */
function RepoView(props: RepoViewProps) {
  return (
    <div className="repo-view">
      <RepoSummary {...props} />
      <ErrorBoundary action="draw the commit graph">
        <CommitGraph layout={props.layout} labels={props.labels} />
      </ErrorBoundary>
    </div>
  );
}

function RepoSummary({ info, graph, loadMs, onOpenAnother }: RepoViewProps) {
  const count = (kind: RefKind) => graph.refs.refs.filter((r) => r.kind === kind).length;
  const changes =
    graph.status.staged.length + graph.status.unstaged.length + graph.status.conflicted.length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  // Move focus to the repository that just opened (keyboard and screen-reader users).
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [info.root]);
  return (
    <section aria-label="Repository summary" className="repo-summary">
      <h2 ref={heading} tabIndex={-1}>
        {info.name}
      </h2>
      {info.root !== info.name && <p className="path">{info.root}</p>}
      <ul className="facts">
        <li data-testid="commit-count">{plural(graph.log.length, "commit")}</li>
        <li>{plural(count("localBranch"), "branch", "branches")}</li>
        <li>{plural(count("remoteBranch"), "remote branch", "remote branches")}</li>
        <li>{plural(count("tag"), "tag")}</li>
        <li>{plural(graph.stashes.length, "stash", "stashes")}</li>
        <li>{graph.status.skipped ? "changes not read" : plural(changes, "changed file")}</li>
      </ul>
      {graph.status.skipped && (
        <p className="note" data-testid="status-skipped">
          Working tree not read: {graph.status.skipped}.
        </p>
      )}
      <p className="timing" data-testid="load-time">
        Loaded in {Math.round(loadMs)} ms
      </p>
      <button type="button" onClick={onOpenAnother}>
        Open another repository…
      </button>
    </section>
  );
}
