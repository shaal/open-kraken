/**
 * The labels of the Branch / Tag column (spec §1 Ref labels): which pills a
 * commit gets, in which order, and what each pill shows.
 */

import type { Ref } from "../git/bindings/Ref";
import type { RepoRefs } from "../git/bindings/RepoRefs";

/** One pill: a branch (local, remote, or both), a tag, or a detached HEAD. */
export interface RefPill {
  /**
   * The text in the pill: the branch or tag name, a remote-only branch's name
   * without its remote ("main" for `origin/main`), or "HEAD".
   */
  label: string;
  /** The full names, for the hover text: `["feature/login", "origin/feature/login"]`. */
  names: string[];
  /** Laptop icon: a local branch. */
  local: boolean;
  /** Cloud icon: a remote branch (alone, or at the same commit as its local branch). */
  remote: boolean;
  /** Tag icon. */
  tag: boolean;
  /** `✓`: the checked-out branch, or the detached HEAD. */
  checkedOut: boolean;
  /** The refs this pill stands for (none for a detached HEAD). */
  refs: Ref[];
}

/** The labels of one commit. */
export interface CommitLabels {
  /** At least one. The first is shown; the others are counted in the `+N` badge. */
  pills: RefPill[];
  /** HEAD points at this commit (through a branch or detached). */
  head: boolean;
}

/** Labels by commit sha; commits without refs have no entry. */
export type RefLabels = ReadonlyMap<string, CommitLabels>;

export const NO_REF_LABELS: RefLabels = new Map();

/** Code-unit order, so the result never depends on the locale. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `origin/main` → `main`. */
function withoutRemote(ref: Ref): string {
  const prefix = ref.remote === null ? null : `${ref.remote}/`;
  return prefix !== null && ref.shortName.startsWith(prefix) && ref.shortName.length > prefix.length
    ? ref.shortName.slice(prefix.length)
    : ref.shortName;
}

/**
 * Builds the labels of every commit in `log` that a ref (or a detached HEAD)
 * points at. Refs and the log are separate reads, so a ref whose commit is not
 * in the log is skipped.
 *
 * Per commit, the pills are, in order: a detached HEAD; the checked-out branch;
 * the other local branches; remote branches that no local branch took; tags
 * (each group by name). A remote branch joins a local branch at the same
 * commit (one pill, laptop and cloud icons) when it is that branch's upstream,
 * or else when it has the same name on its remote (`origin/x` and `x`). The
 * `✓` goes to the checked-out branch only where HEAD points: refs and HEAD are
 * separate reads, so they can disagree after a commit lands between them.
 */
export function buildRefLabels(refs: RepoRefs, log: Iterable<{ sha: string }>): RefLabels {
  const inLog = new Set<string>();
  for (const commit of log) inLog.add(commit.sha);

  const bySha = new Map<string, Ref[]>();
  for (const ref of refs.refs) {
    if (!inLog.has(ref.sha)) continue;
    const list = bySha.get(ref.sha);
    if (list) list.push(ref);
    else bySha.set(ref.sha, [ref]);
  }

  const head = refs.head;
  const headSha = head.sha;
  const labels = new Map<string, CommitLabels>();
  for (const [sha, list] of bySha) {
    const checkedOut = head.type === "branch" && sha === headSha ? head.name : null;
    labels.set(sha, { pills: pillsOf(list, checkedOut), head: false });
  }
  if (headSha === null || !inLog.has(headSha)) return labels;
  const entry = labels.get(headSha);
  if (head.type === "detached") {
    const pill: RefPill = {
      label: "HEAD",
      names: ["HEAD"],
      local: false,
      remote: false,
      tag: false,
      checkedOut: true,
      refs: [],
    };
    labels.set(headSha, { pills: [pill, ...(entry?.pills ?? [])], head: true });
  } else if (entry) {
    // A checked-out branch missing from the refs read gets no pill and no `✓`.
    entry.head = true;
  }
  return labels;
}

/** `origin/x` for `x`: a remote branch with the local branch's name. */
function sameName(local: Ref, remote: Ref): boolean {
  return remote.remote !== null && remote.shortName === `${remote.remote}/${local.shortName}`;
}

/**
 * The pills of one commit's refs, without a detached HEAD. `checkedOut` is the
 * full name of the checked-out branch when HEAD points at this commit.
 */
function pillsOf(refs: Ref[], checkedOut: string | null): RefPill[] {
  const sorted = [...refs].sort((a, b) => byText(a.shortName, b.shortName));
  const locals = sorted.filter((r) => r.kind === "localBranch");
  const remotes = sorted.filter((r) => r.kind === "remoteBranch");
  const tags = sorted.filter((r) => r.kind === "tag");
  // One ✓ at most, even if a name shows up twice (lossy non-UTF-8 names).
  const current = locals.find((l) => l.name === checkedOut);

  // Each remote branch joins at most one local branch. Upstreams first: when
  // several branches track it, the one with its name, else the checked-out
  // one, else the first by name. Then names.
  const joined = new Map<Ref, Ref[]>(locals.map((l) => [l, []]));
  const taken = new Set<Ref>();
  const join = (remote: Ref, local: Ref | undefined) => {
    if (!local) return;
    joined.get(local)?.push(remote);
    taken.add(remote);
  };
  for (const remote of remotes) {
    const tracking = locals.filter((l) => l.upstream === remote.name);
    join(
      remote,
      tracking.find((l) => sameName(l, remote)) ??
        tracking.find((l) => l === current) ??
        tracking[0],
    );
  }
  for (const remote of remotes) {
    if (!taken.has(remote))
      join(
        remote,
        locals.find((l) => sameName(l, remote)),
      );
  }

  const localPills = locals.map((local): RefPill => {
    const withRemotes = [local, ...(joined.get(local) ?? [])];
    return {
      label: local.shortName,
      names: withRemotes.map((r) => r.shortName),
      local: true,
      remote: withRemotes.length > 1,
      tag: false,
      checkedOut: local === current,
      refs: withRemotes,
    };
  });
  // The checked-out branch first; the sort is stable, so the rest keep name order.
  localPills.sort((a, b) => Number(b.checkedOut) - Number(a.checkedOut));

  // Without its remote, unless the commit has another ref that would then
  // read the same (`origin/x` beside `up/x`, a tag `x` or a local `x`).
  const alone = remotes.filter((r) => !taken.has(r));
  const shortLabels = alone.map(withoutRemote);
  const otherNames = new Set([...locals, ...tags].map((r) => r.shortName));
  const remotePills = alone.map((remote, i): RefPill => ({
    label:
      shortLabels.indexOf(shortLabels[i] ?? "") === shortLabels.lastIndexOf(shortLabels[i] ?? "") &&
      !otherNames.has(shortLabels[i] ?? "")
        ? (shortLabels[i] ?? remote.shortName)
        : remote.shortName,
    names: [remote.shortName],
    local: false,
    remote: true,
    tag: false,
    checkedOut: false,
    refs: [remote],
  }));
  const tagPills = tags.map((tag): RefPill => ({
    label: tag.shortName,
    names: [tag.shortName],
    local: false,
    remote: false,
    tag: true,
    checkedOut: false,
    refs: [tag],
  }));
  return [...localPills, ...remotePills, ...tagPills];
}

/** What a pill is, in words, for screen readers. */
export function describePill(pill: RefPill): string {
  if (pill.refs.length === 0) return "detached";
  if (pill.tag) return pill.refs[0]?.annotated ? "annotated tag" : "tag";
  if (pill.local && pill.remote) return "local and remote branch";
  return pill.local ? "local branch" : "remote branch";
}
