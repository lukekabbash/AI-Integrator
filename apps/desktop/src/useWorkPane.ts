import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";

import { watchLayoutShift } from "./layoutShift";

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
  NEW_SURFACE,
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
  /** Opens (or brings forward) the one blank tab, which shows the launcher. */
  openNew: () => void;
  openSubagent: (delegationId: string, options?: { activate?: boolean; show?: boolean }) => void;
  openBrowser: (tabId: string, options?: { activate?: boolean; show?: boolean }) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeToRight: (id: string) => void;
  closeAll: () => void;
  toggle: (open?: boolean) => void;
  setWidth: (width: number) => void;
  /** Widen or narrow by a pointer delta, read against the live width. */
  nudgeWidth: (delta: number) => void;
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
      openNew: () => update((current) => openSurface(current, NEW_SURFACE)),
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
      // A drag reads the width inside the update, never from a snapshot the
      // pointer listener captured when the gesture started — that snapshot
      // goes stale on the first move and the pane snaps back to it.
      nudgeWidth: (delta) => update((current) => setPaneWidth(current, current.width - delta)),
      reorder: (from, to) => update((current) => reorderSurfaces(current, from, to)),
      prune: (keep) => update((current) => pruneSurfaces(current, keep)),
    }),
    [state, update],
  );
}

const EMPTY = createWorkPaneState();

export { fileSurfaceId };

/** A box this small is an opening slide, a pop-out reparent, or an unlaid-out
 *  first frame — never a real place to hang the titlebar tab strip. */
const HEADER_PANE_MIN_SIZE = 32;

export interface HeaderRect {
  left: number;
  width: number;
  height: number;
}

export interface WorkPaneHeaderAlignment {
  paneLeft: number;
  endWidth: number;
}

/**
 * Maps the live pane box onto the titlebar slot. Returns null when the pane
 * is not a usable measurement so the last good offset stays put — a 0×0 or
 * left-edge reading would cover File / Edit / View and the chat title.
 */
export function measureWorkPaneHeaderAlignment(input: {
  root: HeaderRect;
  pane: HeaderRect;
  headerEnd?: Pick<HeaderRect, "width"> | null;
  reservedLeft?: number;
}): WorkPaneHeaderAlignment | null {
  if (input.pane.width < HEADER_PANE_MIN_SIZE || input.pane.height < 8) return null;
  const reserved = Math.max(0, input.reservedLeft ?? 0);
  const raw = input.pane.left - input.root.left;
  if (!Number.isFinite(raw)) return null;
  return {
    paneLeft: Math.max(reserved, raw),
    endWidth: Math.round(input.headerEnd?.width ?? 0),
  };
}

function applyWorkPaneHeaderAlignment(root: HTMLElement, alignment: WorkPaneHeaderAlignment) {
  root.style.setProperty("--subagent-pane-left", `${Math.round(alignment.paneLeft)}px`);
  root.style.setProperty("--titlebar-end-width", `${alignment.endWidth}px`);
  root.dataset.subagentLayoutReady = "true";
}

/** Keeps the titlebar tab-strip slice aligned over the pane. */
export function useWorkPaneHeaderAlignment(
  rootRef: RefObject<HTMLElement | null>,
  paneRef: RefObject<HTMLElement | null>,
  open: boolean,
) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !open) return;
    // The header keeps the view tabs, the usage pill and the window controls at
    // its right end whether or not the pane is open. The strip shares that row,
    // so it has to know how much of the right side is already taken rather than
    // guessing at a constant that goes stale the moment the cluster changes.
    const headerEnd = root.querySelector<HTMLElement>(".titlebar-end");
    const titlebarLeft = root.querySelector<HTMLElement>(".titlebar-left");
    const watched = new Set<Element>();
    let observer: ResizeObserver | undefined;
    let raf = 0;
    let openingFrames = 0;
    // The pane is a fixed-width column: a sidebar sliding open moves it
    // without resizing it, and its own ResizeObserver stays silent. Follow the
    // neighbours that push it around as well, once the pane exists.
    let stopShift: (() => void) | undefined;

    const watch = (node: Element | null | undefined) => {
      if (!node || watched.has(node) || !observer) return;
      watched.add(node);
      observer.observe(node);
      if (node === paneRef.current && !stopShift) stopShift = watchLayoutShift(node, align);
    };

    const schedule = () => {
      if (raf || openingFrames >= 12) return;
      openingFrames += 1;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        align();
      });
    };

    const align = () => {
      const pane = paneRef.current;
      watch(pane);
      if (!pane) {
        schedule();
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const next = measureWorkPaneHeaderAlignment({
        root: rootRect,
        pane: pane.getBoundingClientRect(),
        headerEnd: headerEnd?.getBoundingClientRect() ?? null,
        reservedLeft: titlebarLeft
          ? titlebarLeft.getBoundingClientRect().right - rootRect.left
          : 0,
      });
      // Tab switches and pop-outs remount the native page and can hand us a
      // collapsed box for a frame. Keep the last good offset instead of
      // sliding the strip over File / Edit / View.
      if (next) {
        applyWorkPaneHeaderAlignment(root, next);
        return;
      }
      schedule();
    };

    observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(align);
    watch(root);
    watch(headerEnd);
    watch(titlebarLeft);
    align();
    window.addEventListener("resize", align);
    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      stopShift?.();
      window.removeEventListener("resize", align);
      delete root.dataset.subagentLayoutReady;
      root.style.removeProperty("--subagent-pane-left");
      root.style.removeProperty("--titlebar-end-width");
    };
  }, [rootRef, paneRef, open]);
}
