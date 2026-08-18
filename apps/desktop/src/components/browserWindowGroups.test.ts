import { describe, expect, it } from "vitest";

import { cycledTabId } from "./browserWindowTabs";
import {
  assignGroupColors,
  GROUP_COLOR_COUNT,
  groupColorIndex,
  groupIdForNewTab,
  groupTabs,
  nextActiveAfterCollapse,
  truncateGroupName,
  visibleTabs,
  type GroupKind,
  type GroupTabLike,
} from "./browserWindowGroups";

function tab(
  id: string,
  groupId: string,
  extra: { name?: string; kind?: GroupKind; heldBy?: string } = {},
): GroupTabLike {
  return {
    id,
    groupId,
    groupName: extra.name ?? groupId,
    groupKind: extra.kind ?? "project",
    heldBy: extra.heldBy,
  };
}

const none = new Set<string>();

describe("groupTabs", () => {
  it("orders groups by first appearance and keeps tab order inside them", () => {
    const groups = groupTabs(
      [tab("1", "alpha"), tab("2", "beta"), tab("3", "alpha"), tab("4", "beta")],
      none,
      null,
    );
    expect(groups.map((group) => group.id)).toEqual(["alpha", "beta"]);
    expect(groups[0].tabs.map((each) => each.id)).toEqual(["1", "3"]);
    expect(groups[1].tabs.map((each) => each.id)).toEqual(["2", "4"]);
  });

  it("carries the group's name and kind off its first tab", () => {
    const groups = groupTabs([tab("1", "chat", { name: "Chat", kind: "chat" })], none, null);
    expect(groups[0]).toMatchObject({ name: "Chat", kind: "chat" });
  });

  it("is live only when an agent other than you holds a tab", () => {
    const groups = groupTabs(
      [tab("1", "alpha", { heldBy: "you" }), tab("2", "beta", { heldBy: "claude" })],
      none,
      null,
    );
    expect(groups.map((group) => group.live)).toEqual([false, true]);
  });

  it("marks a collapsed group that hides the active tab", () => {
    const groups = groupTabs(
      [tab("1", "alpha"), tab("2", "beta")],
      new Set(["alpha", "beta"]),
      "1",
    );
    expect(groups.map((group) => group.activeHidden)).toEqual([true, false]);
  });
});

describe("group colours", () => {
  it("hashes into 1..8 and nudges to the next free bucket", () => {
    expect(groupColorIndex("a", new Set())).toBe(5);
    expect(groupColorIndex("a", new Set([5]))).toBe(6);
    expect(groupColorIndex("a", new Set([5, 6, 7]))).toBe(8);
    // wraps past the top of the range
    expect(groupColorIndex("h", new Set([8]))).toBe(1);
  });

  it("falls back to the hashed pick when every colour is taken", () => {
    const all = new Set(Array.from({ length: GROUP_COLOR_COUNT }, (_, index) => index + 1));
    expect(groupColorIndex("a", all)).toBe(5);
  });

  it("gives the same ids the same colours every time", () => {
    expect([...assignGroupColors(["a", "b"])]).toEqual([...assignGroupColors(["a", "b"])]);
  });

  it("nudges the new group, not the one already on screen", () => {
    const before = assignGroupColors(["a", "b"]);
    expect(before.get("a")).toBe(5);
    expect(before.get("b")).toBe(6);
    // "i" hashes onto "a"'s bucket
    const after = assignGroupColors(["a", "b", "i"]);
    expect(after.get("a")).toBe(5);
    expect(after.get("b")).toBe(6);
    expect(after.get("i")).toBe(7);
  });
});

describe("truncateGroupName", () => {
  it("leaves short names alone", () => {
    expect(truncateGroupName("Chat")).toBe("Chat");
    expect(truncateGroupName("fourteen chars")).toBe("fourteen chars");
  });

  it("ellipsises longer ones to the limit", () => {
    expect(truncateGroupName("integrator-3-browser")).toBe("integrator-3-…");
    expect(truncateGroupName("integrator-3-browser").length).toBe(14);
    expect(truncateGroupName("integrator-3-browser", 6)).toBe("integ…");
  });
});

describe("visibleTabs", () => {
  it("skips collapsed groups and keeps strip order", () => {
    const groups = groupTabs(
      [tab("1", "alpha"), tab("2", "beta"), tab("3", "alpha"), tab("4", "gamma")],
      new Set(["beta"]),
      null,
    );
    expect(visibleTabs(groups).map((each) => each.id)).toEqual(["1", "3", "4"]);
  });
});

describe("nextActiveAfterCollapse", () => {
  const tabs = [tab("1", "alpha"), tab("2", "beta"), tab("3", "beta"), tab("4", "gamma")];

  it("takes the first visible tab after the collapsed group", () => {
    expect(nextActiveAfterCollapse("2", groupTabs(tabs, new Set(["beta"]), "2"))).toBe("4");
  });

  it("falls back to the last visible tab before it", () => {
    expect(nextActiveAfterCollapse("2", groupTabs(tabs, new Set(["beta", "gamma"]), "2"))).toBe(
      "1",
    );
  });

  it("returns null when nothing is left visible", () => {
    const groups = groupTabs(tabs, new Set(["alpha", "beta", "gamma"]), "2");
    expect(nextActiveAfterCollapse("2", groups)).toBeNull();
    expect(nextActiveAfterCollapse(null, groups)).toBeNull();
    expect(nextActiveAfterCollapse("missing", groups)).toBeNull();
  });
});

describe("groupIdForNewTab", () => {
  const groups = groupTabs([tab("1", "alpha"), tab("2", "beta")], none, null);

  it("prefers the group in front, then the last one used, then the first pill", () => {
    expect(groupIdForNewTab("beta", "alpha", groups)).toBe("beta");
    expect(groupIdForNewTab(null, "beta", groups)).toBe("beta");
    expect(groupIdForNewTab(null, null, groups)).toBe("alpha");
  });

  it("ignores groups that have gone away", () => {
    expect(groupIdForNewTab("gone", "beta", groups)).toBe("beta");
    expect(groupIdForNewTab("gone", "also-gone", groups)).toBe("alpha");
    expect(groupIdForNewTab("gone", "also-gone", [])).toBeNull();
  });
});

describe("cycling over the visible list", () => {
  it("steps past a collapsed group's tabs", () => {
    const groups = groupTabs(
      [tab("1", "alpha"), tab("2", "beta"), tab("3", "beta"), tab("4", "gamma")],
      new Set(["beta"]),
      "1",
    );
    const visible = visibleTabs(groups);
    expect(cycledTabId("1", visible, 1)).toBe("4");
    expect(cycledTabId("4", visible, 1)).toBe("1");
    expect(cycledTabId("1", visible, -1)).toBe("4");
  });
});
