import { describe, expect, it } from "vitest";

import { forkTitleBase, nextForkTitle, parseForkTitle } from "./forkTitle";

describe("parseForkTitle", () => {
  it("splits a marker off a fork title", () => {
    expect(parseForkTitle("Port the parser: Copy 1")).toEqual({
      base: "Port the parser",
      kind: "Copy",
      index: 1,
    });
    expect(parseForkTitle("Port the parser: Branch 12")).toEqual({
      base: "Port the parser",
      kind: "Branch",
      index: 12,
    });
  });

  it("leaves ordinary titles alone, including near-misses", () => {
    for (const title of [
      "Port the parser",
      "Copy 1",
      "Port the parser: Copy",
      "Port the parser: Copy one",
      "Port the parser: Copy 0",
      "Port the parser: Fork 1",
      "Copy 1: Port the parser",
    ]) {
      expect(parseForkTitle(title), title).toBeNull();
    }
  });

  it("keeps a colon that belongs to the name itself", () => {
    expect(parseForkTitle("Bug: the parser: Copy 2")).toEqual({
      base: "Bug: the parser",
      kind: "Copy",
      index: 2,
    });
    expect(forkTitleBase("Bug: the parser")).toBe("Bug: the parser");
  });
});

describe("nextForkTitle", () => {
  it("numbers from one and counts kinds separately", () => {
    expect(nextForkTitle("Port the parser", "Copy", [])).toBe("Port the parser: Copy 1");
    expect(
      nextForkTitle("Port the parser", "Branch", ["Port the parser", "Port the parser: Copy 1"]),
    ).toBe("Port the parser: Branch 1");
  });

  it("numbers past the highest existing fork rather than the count", () => {
    const existing = ["Port the parser", "Port the parser: Copy 1", "Port the parser: Copy 3"];
    expect(nextForkTitle("Port the parser", "Copy", existing)).toBe("Port the parser: Copy 4");
    // Deleting Copy 3 must not hand out a number that is still in use.
    expect(nextForkTitle("Port the parser", "Copy", ["Port the parser: Copy 1"])).toBe(
      "Port the parser: Copy 2",
    );
  });

  it("strips and increments so forks of forks do not nest", () => {
    const existing = ["Port the parser", "Port the parser: Copy 1"];
    expect(nextForkTitle("Port the parser: Copy 1", "Copy", existing)).toBe(
      "Port the parser: Copy 2",
    );
    expect(nextForkTitle("Port the parser: Copy 1", "Branch", existing)).toBe(
      "Port the parser: Branch 1",
    );
  });

  it("scopes numbering to the base so unrelated chats never collide", () => {
    const existing = ["Port the parser: Copy 1", "Ship the release: Copy 1"];
    expect(nextForkTitle("Ship the release", "Copy", existing)).toBe("Ship the release: Copy 2");
  });

  it("truncates the name, never the marker, at the store's title limit", () => {
    const long = "x".repeat(300);
    const title = nextForkTitle(long, "Copy", []);
    expect(title.length).toBe(240);
    expect(title.endsWith(": Copy 1")).toBe(true);
  });
});
