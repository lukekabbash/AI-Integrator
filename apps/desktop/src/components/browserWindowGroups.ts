/** The strip model for the popped-out browser window: tabs are drawn under a
 *  coloured pill per group, and a group can be collapsed away.
 *
 *  `BrowserTab` grows `groupId`/`groupName`/`groupKind` in step A0; everything
 *  here takes the structural shape instead so the model and its tests stand on
 *  their own. */
export type GroupKind = "chat" | "project" | "path";

/** The fields the strip model reads off a tab. */
export interface GroupTabLike {
  id: string;
  groupId: string;
  groupName: string;
  groupKind: GroupKind;
  heldBy?: string;
}

/** One pill and the tabs it owns, in strip order. */
export interface StripGroup<T extends GroupTabLike = GroupTabLike> {
  id: string;
  name: string;
  kind: GroupKind;
  /** 1..8, an index into the `--color-group-*` tokens. */
  colorIndex: number;
  tabs: T[];
  collapsed: boolean;
  /** Some tab is held by an agent — anyone but you. */
  live: boolean;
  /** Collapsed with the active tab inside, so the selection has nowhere to sit. */
  activeHidden: boolean;
}

/** How many `--color-group-*` tokens the theme defines. */
export const GROUP_COLOR_COUNT = 8;

/** FNV-1a, 32-bit. Small, stable across runs, and enough to spread group ids
 *  over eight buckets. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The group's own colour, nudged to the next free one when that bucket is
 *  already spoken for. Falls back to the hashed pick when all eight are taken. */
export function groupColorIndex(groupId: string, taken: ReadonlySet<number>): number {
  const first = (fnv1a32(groupId) % GROUP_COLOR_COUNT) + 1;
  for (let step = 0; step < GROUP_COLOR_COUNT; step += 1) {
    const candidate = ((first - 1 + step) % GROUP_COLOR_COUNT) + 1;
    if (!taken.has(candidate)) return candidate;
  }
  return first;
}

/** Colours for the window's groups. Input order decides who nudges whom, so
 *  pass the current strip order: an existing pill keeps its colour and the new
 *  group takes the nudge. */
export function assignGroupColors(groupIds: readonly string[]): Map<string, number> {
  const colors = new Map<string, number>();
  const taken = new Set<number>();
  for (const groupId of groupIds) {
    if (colors.has(groupId)) continue;
    const color = groupColorIndex(groupId, taken);
    colors.set(groupId, color);
    taken.add(color);
  }
  return colors;
}

/** Group the strip. Group order is first appearance; tabs keep the order they
 *  came in (native sorts them by creation). */
export function groupTabs<T extends GroupTabLike>(
  tabs: readonly T[],
  collapsed: ReadonlySet<string>,
  activeId: string | null,
): StripGroup<T>[] {
  const groups: StripGroup<T>[] = [];
  const byId = new Map<string, StripGroup<T>>();
  for (const tab of tabs) {
    let group = byId.get(tab.groupId);
    if (!group) {
      group = {
        id: tab.groupId,
        name: tab.groupName,
        kind: tab.groupKind,
        colorIndex: 1,
        tabs: [],
        collapsed: collapsed.has(tab.groupId),
        live: false,
        activeHidden: false,
      };
      byId.set(tab.groupId, group);
      groups.push(group);
    }
    group.tabs.push(tab);
    if (tab.heldBy && tab.heldBy !== "you") group.live = true;
    if (group.collapsed && activeId !== null && tab.id === activeId) group.activeHidden = true;
  }
  const colors = assignGroupColors(groups.map((group) => group.id));
  for (const group of groups) group.colorIndex = colors.get(group.id) ?? 1;
  return groups;
}

/** The tabs actually drawn, in strip order: collapsed groups contribute none. */
export function visibleTabs<T extends GroupTabLike>(groups: readonly StripGroup<T>[]): T[] {
  return groups.flatMap((group) => (group.collapsed ? [] : group.tabs));
}

/** Pill text. No mid-word care — a pill is 120px wide and the tooltip has the
 *  full name. */
export function truncateGroupName(name: string, max = 14): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}…`;
}

/** Where the selection goes when the active tab's group collapses: the nearest
 *  visible tab after that group, else the last one before it, else nothing.
 *  `groups` is the state *after* the collapse. */
export function nextActiveAfterCollapse<T extends GroupTabLike>(
  activeId: string | null,
  groups: readonly StripGroup<T>[],
): string | null {
  if (activeId === null) return null;
  const index = groups.findIndex((group) => group.tabs.some((tab) => tab.id === activeId));
  if (index < 0) return null;
  const after = visibleTabs(groups.slice(index + 1));
  if (after.length > 0) return after[0].id;
  const before = visibleTabs(groups.slice(0, index));
  return before.length > 0 ? before[before.length - 1].id : null;
}

/** Which group a new tab belongs to: the one in front, else the last one used
 *  here, else the first pill. Ids that no longer exist are ignored. */
export function groupIdForNewTab<T extends GroupTabLike>(
  activeGroupId: string | null | undefined,
  lastGroupId: string | null | undefined,
  groups: readonly StripGroup<T>[],
): string | null {
  const has = (id: string | null | undefined): id is string =>
    Boolean(id) && groups.some((group) => group.id === id);
  if (has(activeGroupId)) return activeGroupId;
  if (has(lastGroupId)) return lastGroupId;
  return groups[0]?.id ?? null;
}
