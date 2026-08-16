import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";

import {
  activateSurface,
  activeSurface,
  browserSurface,
  closeAllSurfaces,
  closeOtherSurfaces,
  closeSurface,
  closeSurfacesToRight,
  createWorkPaneState,
  fileSurface,
  fileSurfaceId,
  openSurface,
  parseWorkPane,
  pruneSurfaces,
  reorderSurfaces,
  REVIEW_SURFACE,
  serializeWorkPane,
  setPaneWidth,
  subagentSurface,
  togglePane,
  WORK_PANE_STORAGE_KEY,
  type WorkPaneByTask,
  type WorkPaneState,
  type WorkSurface,
} from "./workPaneModel";

export interface WorkPaneController {
  state: WorkPaneState;
  active: WorkSurface | null;
  openFile: (path: string, revealLine?: number | null, options?: { activate?: boolean }) => void;
  openReview: () => void;
  openSubagent: (delegationId: string, options?: { activate?: boolean; show?: boolean }) => void;
  openBrowser: (tabId: string, options?: { activate?: boolean; show?: boolean }) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeToRight: (id: string) => void;
  closeAll: () => void;
  toggle: (open?: boolean) => void;
  setWidth: (width: number) => void;
  reorder: (from: number, to: number) => void;
  prune: (keep: (surface: WorkSurface) => boolean) => void;
}

function readStored(): WorkPaneByTask {
  if (typeof window === "undefined") return {};
  try {
    return parseWorkPane(window.localStorage.getItem(WORK_PANE_STORAGE_KEY));
  } catch {
    return {};
  }
}

/**
 * Per-owner (task or drafting project) work-pane state with debounced local
 * persistence. Browser tabs are kept in memory only; the model drops them on
 * serialisation because their native sessions do not outlive the process.
 */
export function useWorkPane(ownerKey: string): WorkPaneController {
  const [byOwner, setByOwner] = useState<WorkPaneByTask>(readStored);
  const state = byOwner[ownerKey] ?? EMPTY;

  const update = useCallback(
    (recipe: (current: WorkPaneState) => WorkPaneState) => {
      if (!ownerKey) return;
      setByOwner((current) => {
        const previous = current[ownerKey] ?? createWorkPaneState();
        const next = recipe(previous);
        return next === previous ? current : { ...current, [ownerKey]: next };
      });
    },
    [ownerKey],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(WORK_PANE_STORAGE_KEY, serializeWorkPane(byOwner));
      } catch {
        // Persistence is best-effort; the pane still works for this session.
      }
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [byOwner]);

  return useMemo<WorkPaneController>(
    () => ({
      state,
      active: activeSurface(state),
      openFile: (path, revealLine = null, options) =>
        update((current) => openSurface(current, fileSurface(path, revealLine), options)),
      openReview: () => update((current) => openSurface(current, REVIEW_SURFACE)),
      openSubagent: (delegationId, options) =>
        update((current) => openSurface(current, subagentSurface(delegationId), options)),
      openBrowser: (tabId, options) =>
        update((current) => openSurface(current, browserSurface(tabId), options)),
      activate: (id) => update((current) => activateSurface(current, id)),
      close: (id) => update((current) => closeSurface(current, id)),
      closeOthers: (id) => update((current) => closeOtherSurfaces(current, id)),
      closeToRight: (id) => update((current) => closeSurfacesToRight(current, id)),
      closeAll: () => update(closeAllSurfaces),
      toggle: (open) => update((current) => togglePane(current, open)),
      setWidth: (width) => update((current) => setPaneWidth(current, width)),
      reorder: (from, to) => update((current) => reorderSurfaces(current, from, to)),
      prune: (keep) => update((current) => pruneSurfaces(current, keep)),
    }),
    [state, update],
  );
}

const EMPTY = createWorkPaneState();

export { fileSurfaceId };

/** Keeps the titlebar tab-strip slice aligned over the pane. */
export function useWorkPaneHeaderAlignment(
  rootRef: RefObject<HTMLElement | null>,
  paneRef: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const pane = paneRef.current;
    if (!root || !pane || !open) return;
    const align = () => {
      const rootRect = root.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      root.style.setProperty(
        "--subagent-pane-left",
        `${Math.max(0, paneRect.left - rootRect.left)}px`,
      );
      root.dataset.subagentLayoutReady = "true";
    };
    align();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(align);
    observer?.observe(root);
    observer?.observe(pane);
    window.addEventListener("resize", align);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", align);
      delete root.dataset.subagentLayoutReady;
      root.style.removeProperty("--subagent-pane-left");
    };
  }, [rootRef, paneRef, open, width]);
}
