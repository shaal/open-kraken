import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../git/bindings/Fixture";
import type { Head } from "../git/bindings/Head";
import type { Ref } from "../git/bindings/Ref";
import { buildRefLabels, describePill, type RefLabels, type RefPill } from "./refLabels";

// Vitest runs from the repository root.
function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `fixtures/${name}.json`), "utf8"),
  ) as Fixture;
}

/** A pill in one string: `✓` if checked out, the label, then its icons. */
function pillText(pill: RefPill): string {
  const icons = [pill.local && "local", pill.remote && "remote", pill.tag && "tag"].filter(Boolean);
  return `${pill.checkedOut ? "✓" : ""}${pill.label} [${icons.join(" ")}]`;
}

/** Each labeled commit's subject with its pills, in row order. */
function summary(data: Fixture): Record<string, string[]> {
  const labels = buildRefLabels(data.graph.refs, data.graph.log);
  const out: Record<string, string[]> = {};
  for (const commit of data.graph.log) {
    const entry = labels.get(commit.sha);
    if (entry) out[commit.subject] = entry.pills.map(pillText);
  }
  return out;
}

const sha = (n: number) => n.toString(16).padStart(40, "0");

function local(name: string, at: number, upstream: string | null = null): Ref {
  return {
    name: `refs/heads/${name}`,
    shortName: name,
    kind: "localBranch",
    remote: null,
    sha: sha(at),
    annotated: false,
    upstream,
  };
}

function remote(name: string, at: number, remoteName: string | null = "origin"): Ref {
  return {
    name: `refs/remotes/${name}`,
    shortName: name,
    kind: "remoteBranch",
    remote: remoteName,
    sha: sha(at),
    annotated: false,
    upstream: null,
  };
}

function tag(name: string, at: number, annotated = false): Ref {
  const full = `refs/tags/${name}`;
  return {
    name: full,
    shortName: name,
    kind: "tag",
    remote: null,
    sha: sha(at),
    annotated,
    upstream: null,
  };
}

const onBranch = (name: string, at: number | null): Head => ({
  type: "branch",
  name: `refs/heads/${name}`,
  shortName: name,
  sha: at === null ? null : sha(at),
});
const detached = (at: number): Head => ({ type: "detached", sha: sha(at) });
const log = (...ns: number[]) => ns.map((n) => ({ sha: sha(n) }));

function labelsOf(labels: RefLabels, at: number): string[] | undefined {
  return labels.get(sha(at))?.pills.map(pillText);
}

describe("buildRefLabels", () => {
  it("gives the demo repo GitKraken's labels (spec §1 Ref labels)", () => {
    // As GitKraken showed the demo repo: main checked out; origin/main as "main" with a
    // cloud; local and remote at one commit as one pill with both icons, matched by
    // name (the demo sets no upstreams); a tag behind release/1.1 in a +1 badge.
    expect(summary(fixture("demo-repo"))).toEqual({
      "Update roadmap": ["✓main [local]"],
      "Highlight branch on hover": ["feature/graph-view [local]"],
      "Merge branch 'release/1.1'": ["main [remote]"],
      "Prepare 1.1 release notes": ["release/1.1 [local]", "v1.1 [tag]"],
      "Add regression test for crash": ["bugfix/crash-on-start [local remote]"],
      "Add remember-me option": ["feature/login [local remote]"],
      "Document setup steps": ["v1.0 [tag]"],
    });
    const data = fixture("demo-repo");
    const labels = buildRefLabels(data.graph.refs, data.graph.log);
    const heads = [...labels.entries()].filter(([, entry]) => entry.head).map(([s]) => s);
    expect(heads).toEqual([data.graph.refs.head.sha]);
  });

  it("labels the edge-case repo: upstreams, several tags, a remote-only branch, a detached HEAD", () => {
    const data = fixture("edge-repo");
    expect(data.graph.refs.head.type).toBe("detached");
    expect(summary(data)).toEqual({
      "Rename build script": ["chore/rename-build-script [local]"],
      // Detached at main's tip: HEAD has the ✓, main does not; main's upstream is
      // elsewhere, so no cloud.
      "Update roadmap": ["✓HEAD []", "main [local]"],
      // Joined by upstream: the remote branch has another name.
      "Highlight branch on hover": ["feature/graph-view [local remote]"],
      "Add metrics endpoint": ["nightly [tag]", "qa/passed [tag]", "v1.2 [tag]"],
      "Merge branch 'release/1.1'": ["main [remote]"],
      "Prepare 1.1 release notes": ["release/1.1 [local]", "v1.1 [tag]"],
      "Draw commit lanes": ["experiment [remote]"],
      "Add health endpoint": [
        "feature/a-very-long-branch-name-that-does-not-fit-the-column [local]",
      ],
      "Add regression test for crash": ["bugfix/crash-on-start [local remote]"],
      "Add remember-me option": ["feature/login [local remote]"],
      "Document setup steps": ["v1.0 [tag]"],
    });
    const labels = buildRefLabels(data.graph.refs, data.graph.log);
    const byName = (label: string) =>
      [...labels.values()].flatMap((e) => e.pills).find((p) => p.label === label);
    expect(byName("feature/graph-view")?.names).toEqual(["feature/graph-view", "origin/graph"]);
    expect(byName("experiment")?.names).toEqual(["origin/experiment"]);
    expect(byName("v1.2") && describePill(byName("v1.2") as RefPill)).toBe("annotated tag");
    expect(byName("nightly") && describePill(byName("nightly") as RefPill)).toBe("tag");
    expect(byName("HEAD")?.refs).toEqual([]);
  });

  it("skips refs whose commit is not in the log", () => {
    const labels = buildRefLabels(
      { head: onBranch("main", 1), refs: [local("main", 1), local("gone", 9), tag("t", 9)] },
      log(1, 2),
    );
    expect([...labels.keys()]).toEqual([sha(1)]);
  });

  it("gives no label for a HEAD outside the log", () => {
    expect(buildRefLabels({ head: detached(9), refs: [] }, log(1)).size).toBe(0);
    expect(
      buildRefLabels({ head: onBranch("main", 9), refs: [local("main", 9)] }, log(1)).size,
    ).toBe(0);
    expect(buildRefLabels({ head: onBranch("main", null), refs: [] }, log(1)).size).toBe(0);
  });

  it("labels a detached HEAD alone on a commit without refs", () => {
    const labels = buildRefLabels({ head: detached(2), refs: [local("main", 1)] }, log(1, 2));
    expect(labelsOf(labels, 2)).toEqual(["✓HEAD []"]);
    expect(labels.get(sha(2))?.head).toBe(true);
    expect(labels.get(sha(1))?.head).toBe(false);
    expect(describePill(labels.get(sha(2))?.pills[0] as RefPill)).toBe("detached");
  });

  it("gives no ✓ and no empty label when the checked-out branch is missing from the refs", () => {
    // refs and HEAD are separate reads: the branch can be gone from one of them.
    const labels = buildRefLabels({ head: onBranch("main", 1), refs: [tag("v1", 1)] }, log(1, 2));
    expect(labelsOf(labels, 1)).toEqual(["v1 [tag]"]);
    expect(labels.get(sha(1))?.head).toBe(true);
    const none = buildRefLabels({ head: onBranch("main", 2), refs: [] }, log(1, 2));
    expect(none.size).toBe(0);
  });

  it("puts the ✓ only where HEAD points, when refs and HEAD were read a commit apart", () => {
    // `main` moved from 1 to 2 between the refs read and the HEAD read.
    const labels = buildRefLabels(
      { head: onBranch("main", 2), refs: [local("main", 1), tag("v0", 1)] },
      log(1, 2),
    );
    expect(labelsOf(labels, 1)).toEqual(["main [local]", "v0 [tag]"]);
    expect(labels.has(sha(2))).toBe(false);
    // Before the first commit: HEAD names a branch with no commit.
    const unborn = buildRefLabels(
      { head: onBranch("main", null), refs: [local("main", 1)] },
      log(1),
    );
    expect(labelsOf(unborn, 1)).toEqual(["main [local]"]);
  });

  it("gives one ✓ even when the checked-out branch's name shows up twice", () => {
    // Two non-UTF-8 names can read the same after lossy decoding.
    const labels = buildRefLabels(
      { head: onBranch("main", 1), refs: [local("main", 1), local("main", 1)] },
      log(1),
    );
    expect(labelsOf(labels, 1)).toEqual(["✓main [local]", "main [local]"]);
  });

  it("puts the checked-out branch first, then local, remote-only and tag pills by name", () => {
    const labels = buildRefLabels(
      {
        head: onBranch("zeta", 1),
        refs: [
          tag("a-tag", 1),
          remote("origin/b", 1),
          local("zeta", 1),
          local("alpha", 1),
          local("B", 1),
        ],
      },
      log(1),
    );
    // Code-unit order: "B" sorts before "alpha", whatever the locale.
    expect(labelsOf(labels, 1)).toEqual([
      "✓zeta [local]",
      "B [local]",
      "alpha [local]",
      "b [remote]",
      "a-tag [tag]",
    ]);
  });

  it("joins a remote branch to its local branch: by upstream first, then by name", () => {
    const labels = buildRefLabels(
      {
        head: onBranch("main", 9),
        refs: [
          // `a` tracks origin/b, so origin/b joins `a`, not `b` of the same name.
          local("a", 1, "refs/remotes/origin/b"),
          local("b", 1),
          remote("origin/b", 1),
          // Two branches track origin/c: the first by name takes it.
          local("c1", 2, "refs/remotes/origin/c"),
          local("c2", 2, "refs/remotes/origin/c"),
          remote("origin/c", 2),
          // `zz` and `aa` (made with `checkout -b aa origin/zz`) track origin/zz: `zz` takes it.
          local("aa", 7, "refs/remotes/origin/zz"),
          local("zz", 7, "refs/remotes/origin/zz"),
          remote("origin/zz", 7),
          // Same name on another remote, and on a remote with a slash in its name.
          local("d", 3),
          remote("upstream/d", 3, "upstream"),
          remote("up/stream/d", 3, "up/stream"),
          // An upstream at another commit joins nothing.
          local("e", 4, "refs/remotes/origin/e"),
          remote("origin/e", 5),
          // A remote branch whose remote is unknown keeps its full name.
          remote("weird", 6, null),
        ],
      },
      log(1, 2, 3, 4, 5, 6, 7, 9),
    );
    expect(labelsOf(labels, 7)).toEqual(["aa [local]", "zz [local remote]"]);
    expect(labelsOf(labels, 1)).toEqual(["a [local remote]", "b [local]"]);
    expect(labels.get(sha(1))?.pills[0]?.names).toEqual(["a", "origin/b"]);
    expect(labelsOf(labels, 2)).toEqual(["c1 [local remote]", "c2 [local]"]);
    expect(labels.get(sha(3))?.pills[0]?.names).toEqual(["d", "up/stream/d", "upstream/d"]);
    expect(labelsOf(labels, 4)).toEqual(["e [local]"]);
    expect(labelsOf(labels, 5)).toEqual(["e [remote]"]);
    expect(labelsOf(labels, 6)).toEqual(["weird [remote]"]);
  });

  it("gives a shared upstream to the checked-out branch before the first by name", () => {
    const labels = buildRefLabels(
      {
        head: onBranch("p2", 1),
        refs: [
          local("p1", 1, "refs/remotes/origin/q"),
          local("p2", 1, "refs/remotes/origin/q"),
          remote("origin/q", 1),
        ],
      },
      log(1),
    );
    expect(labelsOf(labels, 1)).toEqual(["✓p2 [local remote]", "p1 [local]"]);
  });

  it("keeps the remote in a remote-only label when another label would read the same", () => {
    const labels = buildRefLabels(
      {
        head: onBranch("main", 9),
        refs: [remote("origin/x", 1), remote("up/x", 1, "up"), remote("origin/y", 1)],
      },
      log(1, 9),
    );
    expect(labelsOf(labels, 1)).toEqual(["origin/x [remote]", "y [remote]", "up/x [remote]"]);
    // Nor one that reads like a tag on the same commit. (A local branch of that
    // name would have taken the remote branch into its own pill.)
    const mixed = buildRefLabels(
      { head: onBranch("main", 9), refs: [tag("v1.1", 2), remote("origin/v1.1", 2)] },
      log(2, 9),
    );
    expect(labelsOf(mixed, 2)).toEqual(["origin/v1.1 [remote]", "v1.1 [tag]"]);
  });

  it("puts every ref in exactly one pill, whatever the refs, HEAD and input order", () => {
    const at = fc.integer({ min: 1, max: 8 }); // commits 1–6 are in the log; 7 and 8 are not
    const name = fc.constantFrom("main", "dev", "x/y", "B", "a");
    const refArb = fc.oneof(
      fc.record({ kind: fc.constant("l" as const), name, at, upstream: fc.option(name) }),
      fc.record({
        kind: fc.constant("r" as const),
        name,
        at,
        remote: fc.constantFrom("origin", "up"),
      }),
      fc.record({ kind: fc.constant("t" as const), name, at, annotated: fc.boolean() }),
    );
    const headArb = fc.oneof(
      fc.record({ type: fc.constant("b" as const), name, at: fc.option(at) }),
      fc.record({ type: fc.constant("d" as const), at }),
    );
    fc.assert(
      fc.property(fc.array(refArb, { maxLength: 14 }), headArb, fc.integer(), (specs, h, seed) => {
        // Full names are unique in git: keep the first of each.
        const refs = new Map<string, Ref>();
        for (const s of specs) {
          const ref =
            s.kind === "l"
              ? local(
                  s.name,
                  s.at,
                  s.upstream === null ? null : `refs/remotes/origin/${s.upstream}`,
                )
              : s.kind === "r"
                ? remote(`${s.remote}/${s.name}`, s.at, s.remote)
                : tag(s.name, s.at, s.annotated);
          if (!refs.has(ref.name)) refs.set(ref.name, ref);
        }
        const head = h.type === "b" ? onBranch(h.name, h.at) : detached(h.at);
        const list = [...refs.values()];
        const inLog = log(1, 2, 3, 4, 5, 6);
        const labels = buildRefLabels({ head, refs: list }, inLog);

        // The same labels for any order of the refs (a Fisher–Yates shuffle from the seed).
        const shuffled = [...list];
        let state = seed >>> 0;
        for (let i = shuffled.length - 1; i > 0; i--) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          const j = state % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j] as Ref, shuffled[i] as Ref];
        }
        expect(buildRefLabels({ head, refs: shuffled }, inLog)).toEqual(labels);

        const inLogShas = new Set(inLog.map((c) => c.sha));
        const placed = new Map<Ref, number>();
        let checkedOut = 0;
        const rank = (p: RefPill) => (p.checkedOut ? 0 : p.local ? 1 : p.tag ? 3 : 2);
        for (const [s, entry] of labels) {
          expect(inLogShas.has(s)).toBe(true);
          expect(entry.pills.length).toBeGreaterThan(0);
          expect(entry.head).toBe(s === head.sha);
          // A remote-only label never reads like another ref's label on the commit.
          for (const pill of entry.pills.filter((p) => !p.local && p.remote)) {
            const same = entry.pills.filter((p) => p !== pill && p.label === pill.label);
            expect(same).toEqual([]);
          }
          entry.pills.forEach((pill, i) => {
            if (pill.checkedOut) {
              checkedOut += 1;
              expect(i).toBe(0);
            }
            if (i > 0)
              expect(rank(pill)).toBeGreaterThanOrEqual(rank(entry.pills[i - 1] as RefPill));
            expect(pill.names).toEqual(
              pill.refs.length ? pill.refs.map((r) => r.shortName) : ["HEAD"],
            );
            for (const ref of pill.refs) {
              expect(ref.sha).toBe(s);
              placed.set(ref, (placed.get(ref) ?? 0) + 1);
            }
            // A pill is one local branch with its remotes, one remote branch, or one tag.
            const [first, ...rest] = pill.refs;
            if (first?.kind === "localBranch") {
              expect(rest.every((r) => r.kind === "remoteBranch")).toBe(true);
              expect(pill.remote).toBe(rest.length > 0);
            } else {
              expect(rest).toEqual([]);
            }
          });
        }
        for (const ref of list) {
          expect(placed.get(ref) ?? 0).toBe(inLogShas.has(ref.sha) ? 1 : 0);
        }
        // One ✓ at most: on the checked-out branch, or on a detached HEAD in the log.
        const branchHere =
          head.type === "branch" &&
          list.some((r) => r.name === head.name && r.sha === head.sha && inLogShas.has(r.sha));
        const detachedHere = head.type === "detached" && inLogShas.has(head.sha);
        expect(checkedOut).toBe(branchHere || detachedHere ? 1 : 0);
      }),
      { numRuns: 400 },
    );
  });
});
