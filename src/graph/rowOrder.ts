/**
 * Row order for the commit graph (spec §6.1): a temporal topological sort.
 *
 * Commits are visited newest first by committer date. From each one, a
 * depth-first walk goes to its children; a commit is placed only after all of
 * its children are placed. So every commit sits above its parents, even when
 * clocks are wrong, and when the dates already agree with the history the
 * result is plain newest-first date order.
 *
 * Written from the prose description in Pierre Vigier, "Commit graph drawing
 * algorithms" (2019); no code from gitamine (GPL) is used.
 */

/** What row ordering needs from a commit. */
export interface OrderInput {
  sha: string;
  /** Parents, first parent first. Parents not in the list are ignored. */
  parents: readonly string[];
  /** Unix seconds. */
  committerTime: number;
}

/** Newest first; equal dates by sha, so the result never depends on input order. */
function newestFirst(a: OrderInput, b: OrderInput): number {
  if (a.committerTime !== b.committerTime) return b.committerTime - a.committerTime;
  return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
}

/**
 * The commits in graph row order, top to bottom: every commit before (above)
 * all of its parents. Throws if a sha appears twice.
 */
export function temporalTopologicalOrder<T extends OrderInput>(commits: readonly T[]): T[] {
  const bySha = new Map<string, T>();
  for (const commit of commits) {
    if (bySha.has(commit.sha)) {
      throw new Error(`duplicate commit ${commit.sha}`);
    }
    bySha.set(commit.sha, commit);
  }

  const children = new Map<string, T[]>();
  for (const commit of commits) {
    for (const parent of new Set(commit.parents)) {
      if (bySha.has(parent)) {
        const list = children.get(parent);
        if (list) list.push(commit);
        else children.set(parent, [commit]);
      }
    }
  }
  for (const list of children.values()) list.sort(newestFirst);

  const starts = [...commits].sort(newestFirst);
  const placed: T[] = [];
  const visited = new Set<string>();
  // An explicit stack: histories are deep enough to overflow recursion.
  const stack: { commit: T; next: number }[] = [];
  for (const start of starts) {
    if (visited.has(start.sha)) continue;
    visited.add(start.sha);
    stack.push({ commit: start, next: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const kids = children.get(top.commit.sha) ?? [];
      const child = kids[top.next];
      if (child !== undefined) {
        top.next += 1;
        if (!visited.has(child.sha)) {
          visited.add(child.sha);
          stack.push({ commit: child, next: 0 });
        }
      } else {
        stack.pop();
        placed.push(top.commit); // all of its children are already placed
      }
    }
  }
  return placed;
}
