import { describe, expect, it } from "vitest";
import { GitCommandError, rangeKey, toGitCommandError } from "./adapter";

describe("toGitCommandError", () => {
  it("keeps the error info a command rejected with", () => {
    const info = { kind: "notARepository" as const, message: "nope", path: "/x", root: null };
    const error = toGitCommandError(info);
    expect(error).toBeInstanceOf(GitCommandError);
    expect(error.info).toEqual(info);
    expect(error.message).toBe("nope");
  });

  it("wraps anything else as an internal error", () => {
    expect(toGitCommandError(new Error("boom")).info).toEqual({
      kind: "internal",
      message: "boom",
      path: null,
      root: null,
    });
    expect(toGitCommandError("plain text").info.message).toBe("plain text");
    expect(toGitCommandError({ kind: 3 }).info.kind).toBe("internal");
  });

  it("passes a GitCommandError through", () => {
    const original = new GitCommandError({
      kind: "internal",
      message: "x",
      path: null,
      root: null,
    });
    expect(toGitCommandError(original)).toBe(original);
  });
});

describe("rangeKey", () => {
  it("sorts and removes duplicates, like git-data's range_key", () => {
    expect(rangeKey(["b", "a", "b"])).toBe("a,b");
    expect(rangeKey([])).toBe("");
  });
});
