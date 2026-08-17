/**
 * Work pane: the tabbed secondary surface between the transcript and the
 * right rail. Files, the review diff, subagent conversations and browser
 * tabs open here as peer tabs so the transcript is never displaced. This
 * module is pure state; components render it and the native side owns any
 * processes (a closed tab never stops a subagent or a browser session).
 */

export type WorkSurface =
  | {
      id: `file:${string}`;
      kind: "file";
      path: string;
      /** 1-based line to reveal; bumping revealRequestId re-reveals the same line. */
      revealLine: number | null;
      revealRequestId: number;
    }
  | { id: "review"; kind: "review" }
  | { id: `subagent:${string}`; kind: "subagent"; delegationId: string }
  | { id: `browser:${string}`; kind: "browser"; tabId: string }
  // An empty tab showing the launcher, opened by the strip's + button. There is
  // only ever one: pressing + again brings it forward rather than stacking blank
  // tabs, and choosing something from it replaces it.
  | { id: "new"; kind: "new" };

export type WorkSurfaceKind = WorkSurface["kind"];

export interface WorkPaneState {
  /** Whether the pane is showing. Surfaces survive a closed pane. */
  open: boolean;
  surfaces: WorkSurface[];
  activeId: string | null;
  /** Requested width in CSS px; the renderer clamps to the row. */
  width: number;
}

export const WORK_PANE_DEFAULT_WIDTH = 460;
export const WORK_PANE_MIN_WIDTH = 320;
export const WORK_PANE_STORAGE_KEY = "aiintegrator.work-pane.v1";

export function createWorkPaneState(overrides: Partial<WorkPaneState> = {}): WorkPaneState {
  return {
    open: false,
    surfaces: [],
    activeId: null,
    width: WORK_PANE_DEFAULT_WIDTH,
    ...overrides,
  };
}

export function fileSurfaceId(path: string): `file:${string}` {
  return `file:${path}`;
}
export function subagentSurfaceId(delegationId: string): `subagent:${string}` {
  return `subagent:${delegationId}`;
}
export function browserSurfaceId(tabId: string): `browser:${string}` {
  return `browser:${tabId}`;
}

export function fileSurface(path: string, revealLine: number | null = null): WorkSurface {
  return { id: fileSurfaceId(path), kind: "file", path, revealLine, revealRequestId: 0 };
}
export const REVIEW_SURFACE: WorkSurface = { id: "review", kind: "review" };
export const NEW_SURFACE: WorkSurface = { id: "new", kind: "new" };
export function subagentSurface(delegationId: string): WorkSurface {
  return { id: subagentSurfaceId(delegationId), kind: "subagent", delegationId };
}
export function browserSurface(tabId: string): WorkSurface {
  return { id: browserSurfaceId(tabId), kind: "browser", tabId };
}

/**
 * Opens a surface (or re-activates an existing one). A re-opened file with a
 * reveal line bumps its request id so the viewer scrolls again. Never
 * duplicates by id. Opening also shows the pane unless `show` is false.
 */
export function openSurface(
  state: WorkPaneState,
  surface: WorkSurface,
  options: { activate?: boolean; show?: boolean } = {},
): WorkPaneState {
  const { activate = true, show = true } = options;
  const existingIndex = state.surfaces.findIndex((candidate) => candidate.id === surface.id);
  let surfaces = state.surfaces;
  if (existingIndex === -1) {
    surfaces = [...state.surfaces, surface];
  } else if (surface.kind === "file") {
    const existing = state.surfaces[existingIndex];
    const next: WorkSurface = {
      ...surface,
      revealRequestId:
        existing.kind === "file"
          ? existing.revealRequestId + (surface.revealLine != null ? 1 : 0)
          : 0,
      revealLine: surface.revealLine ?? (existing.kind === "file" ? existing.revealLine : null),
    };
    surfaces = state.surfaces.map((candidate, index) =>
      index === existingIndex ? next : candidate,
    );
  }
  return {
    ...state,
    surfaces,
    activeId: activate ? surface.id : (state.activeId ?? surface.id),
    open: show ? true : state.open,
  };
}

export function activateSurface(state: WorkPaneState, id: string): WorkPaneState {
  if (!state.surfaces.some((surface) => surface.id === id)) return state;
  return { ...state, activeId: id, open: true };
}

/** Closes one tab; the neighbour to the right (then left) becomes active. */
export function closeSurface(state: WorkPaneState, id: string): WorkPaneState {
  const index = state.surfaces.findIndex((surface) => surface.id === id);
  if (index === -1) return state;
  const surfaces = state.surfaces.filter((surface) => surface.id !== id);
  let activeId = state.activeId;
  if (state.activeId === id) {
    activeId = surfaces[index]?.id ?? surfaces[index - 1]?.id ?? null;
  }
  return { ...state, surfaces, activeId };
}

export function closeOtherSurfaces(state: WorkPaneState, id: string): WorkPaneState {
  const keep = state.surfaces.find((surface) => surface.id === id);
  if (!keep) return state;
  return { ...state, surfaces: [keep], activeId: keep.id };
}

export function closeSurfacesToRight(state: WorkPaneState, id: string): WorkPaneState {
  const index = state.surfaces.findIndex((surface) => surface.id === id);
  if (index === -1) return state;
  const surfaces = state.surfaces.slice(0, index + 1);
  const activeId = surfaces.some((surface) => surface.id === state.activeId) ? state.activeId : id;
  return { ...state, surfaces, activeId };
}

/** Empties the pane but leaves it open, so the launcher shows. */
export function closeAllSurfaces(state: WorkPaneState): WorkPaneState {
  return { ...state, surfaces: [], activeId: null };
}

export function togglePane(state: WorkPaneState, open = !state.open): WorkPaneState {
  return state.open === open ? state : { ...state, open };
}

export function setPaneWidth(state: WorkPaneState, width: number): WorkPaneState {
  const next = Math.max(WORK_PANE_MIN_WIDTH, Math.round(width));
  return state.width === next ? state : { ...state, width: next };
}

export function reorderSurfaces(state: WorkPaneState, from: number, to: number): WorkPaneState {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= state.surfaces.length ||
    to >= state.surfaces.length
  ) {
    return state;
  }
  const surfaces = [...state.surfaces];
  const [moved] = surfaces.splice(from, 1);
  surfaces.splice(to, 0, moved);
  return { ...state, surfaces };
}

export function activeSurface(state: WorkPaneState): WorkSurface | null {
  return state.surfaces.find((surface) => surface.id === state.activeId) ?? null;
}

export function surfacesOfKind<K extends WorkSurfaceKind>(
  state: WorkPaneState,
  kind: K,
): Extract<WorkSurface, { kind: K }>[] {
  return state.surfaces.filter(
    (surface): surface is Extract<WorkSurface, { kind: K }> => surface.kind === kind,
  );
}

/** Drops surfaces whose backing object no longer exists (closed browser tab, finished-and-removed delegation). */
export function pruneSurfaces(
  state: WorkPaneState,
  keep: (surface: WorkSurface) => boolean,
): WorkPaneState {
  const surfaces = state.surfaces.filter(keep);
  if (surfaces.length === state.surfaces.length) return state;
  const activeId = surfaces.some((surface) => surface.id === state.activeId)
    ? state.activeId
    : (surfaces[surfaces.length - 1]?.id ?? null);
  return { ...state, surfaces, activeId };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export type WorkPaneByTask = Record<string, WorkPaneState>;

interface StoredWorkPane {
  version: 1;
  byTask: Record<
    string,
    { open: boolean; width: number; activeId: string | null; surfaces: WorkSurface[] }
  >;
}

/**
 * Browser tabs are native sessions and do not survive a restart, so they are
 * not persisted; files, review and subagent tabs are.
 */
export function serializeWorkPane(byTask: WorkPaneByTask): string {
  const stored: StoredWorkPane = { version: 1, byTask: {} };
  for (const [taskId, state] of Object.entries(byTask)) {
    const surfaces = state.surfaces.filter(
      (surface) => surface.kind !== "browser" && surface.kind !== "new",
    );
    if (surfaces.length === 0 && !state.open && state.width === WORK_PANE_DEFAULT_WIDTH) continue;
    stored.byTask[taskId] = {
      open: state.open,
      width: state.width,
      activeId: surfaces.some((surface) => surface.id === state.activeId)
        ? state.activeId
        : (surfaces[0]?.id ?? null),
      surfaces,
    };
  }
  return JSON.stringify(stored);
}

export function parseWorkPane(raw: string | null | undefined): WorkPaneByTask {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<StoredWorkPane> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.byTask !== "object" || !parsed.byTask) {
      return {};
    }
    const byTask: WorkPaneByTask = {};
    for (const [taskId, entry] of Object.entries(parsed.byTask)) {
      if (!entry || typeof entry !== "object") continue;
      const surfaces = Array.isArray(entry.surfaces)
        ? entry.surfaces.filter(isValidStoredSurface)
        : [];
      byTask[taskId] = createWorkPaneState({
        open: Boolean(entry.open),
        width:
          typeof entry.width === "number" && Number.isFinite(entry.width)
            ? Math.max(WORK_PANE_MIN_WIDTH, entry.width)
            : WORK_PANE_DEFAULT_WIDTH,
        surfaces,
        activeId: surfaces.some((surface) => surface.id === entry.activeId)
          ? (entry.activeId as string)
          : (surfaces[0]?.id ?? null),
      });
    }
    return byTask;
  } catch {
    return {};
  }
}

function isValidStoredSurface(value: unknown): value is WorkSurface {
  if (!value || typeof value !== "object") return false;
  const surface = value as Record<string, unknown>;
  switch (surface.kind) {
    case "file":
      return (
        typeof surface.path === "string" &&
        surface.path.length > 0 &&
        surface.id === fileSurfaceId(surface.path)
      );
    case "review":
      return surface.id === "review";
    case "subagent":
      return (
        typeof surface.delegationId === "string" &&
        surface.id === subagentSurfaceId(surface.delegationId)
      );
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Presentation helpers                                                       */
/* -------------------------------------------------------------------------- */

export function surfaceFileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}
