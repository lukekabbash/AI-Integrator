import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { TabFavicon } from "./components/TabFavicon";
import { arm, cancel, drop, move, target as retarget } from "./browserTabDrag";
import type { DragOrigin, DragState, DropAction, HitTarget, StripRect } from "./browserTabDrag";
import "./browserTabDrag.css";

/** The DOM half of the tab drag: pointer capture, the strip's measurements,
 *  the native hit test, and the ghost that follows the pointer. The rules live
 *  in `browserTabDrag.ts`; this file only feeds them and acts on the answer.
 *
 *  Both strips use it — the popped-out window's, and the work pane's — which
 *  is why the callbacks are handed in rather than reached for. */

/** What the ghost needs to draw, plus the identity the callbacks report. */
export interface TabDragTab {
  id: string;
  taskId: string;
  groupId: string;
  title: string;
  favicon?: string;
}

export interface UseTabDragOptions {
  origin: DragOrigin;
  tabs: readonly TabDragTab[];
  /** The element holding the `[data-traveling-selection]` tabs. */
  stripRef: RefObject<HTMLElement | null>;
  /** The inclusive strip-index range of a tab's group; reordering stays
   *  inside it. */
  groupSpanFor(tabId: string): [number, number];
  /** Native: what is under this *physical* screen point. Left out (the tests,
   *  and any surface without the command) the tab can only tear off. */
  hitTest?(xPhysical: number, yPhysical: number): Promise<HitTarget>;
  /** Native: the drag is over, clear the drag-over highlight. */
  dragEnd?(): Promise<void>;
  onReorder(from: number, to: number): void;
  onMove(tabId: string, taskId: string, label: string, index?: number): void;
  onDock(tabId: string, taskId: string): void;
  /** `at` is logical *screen* px, which is what the native window placement
   *  wants. */
  onTearOff(tabId: string, taskId: string, at: { x: number; y: number }): void;
}

export interface TabDragHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(event: ReactPointerEvent<HTMLElement>): void;
}

export interface TabDrag {
  handlersFor(tabId: string, index: number): TabDragHandlers;
  dragging: boolean;
  draggingTabId: string | null;
  /** Where the dragged tab would land in this strip, for the gap. */
  hoverIndex: number | null;
  ghost: ReactNode;
}

/** The close button and anything opting out own their own pointer. */
const NO_DRAG = "button.file-reader-tab-close, [data-no-drag]";

function isNoDrag(node: EventTarget | null): boolean {
  return node instanceof Element && Boolean(node.closest(NO_DRAG));
}

/** Capture keeps the moves coming once the pointer leaves the tab. It throws
 *  when the pointer is already gone (and jsdom has no capture at all), which
 *  is not a reason to drop the gesture. */
function capturePointer(element: Element, pointerId: number, hold: boolean) {
  try {
    if (hold) element.setPointerCapture?.(pointerId);
    else element.releasePointerCapture?.(pointerId);
  } catch {
    /* no capture available */
  }
}

export function useTabDrag(options: UseTabDragOptions): TabDrag {
  // Every handler reads the live options through the ref, so the handlers
  // themselves never change identity mid-gesture.
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  /** Logical screen px, tracked alongside the client px the machine uses. */
  const screenRef = useRef({ x: 0, y: 0 });
  const hitFrameRef = useRef(0);
  const swallowRef = useRef<((event: MouseEvent) => void) | null>(null);

  const apply = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const measureStrip = useCallback((): StripRect[] => {
    const strip = optionsRef.current.stripRef.current;
    if (!strip) return [];
    return Array.from(strip.querySelectorAll<HTMLElement>("[data-traveling-selection]")).map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      },
    );
  }, []);

  /** The click that follows a drag is not a selection. Capture-phase and
   *  one-shot, cleared on the next tick so a drag with no click after it does
   *  not eat a real one. */
  const swallowNextClick = useCallback(() => {
    const swallow = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      swallowRef.current = null;
    };
    swallowRef.current = swallow;
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => {
      if (swallowRef.current !== swallow) return;
      swallowRef.current = null;
      window.removeEventListener("click", swallow, { capture: true });
    }, 0);
  }, []);

  const finish = useCallback(
    (state: DragState, action: DropAction) => {
      const live = optionsRef.current;
      const torn = state.phase === "torn";
      if (hitFrameRef.current) {
        cancelAnimationFrame(hitFrameRef.current);
        hitFrameRef.current = 0;
      }
      pointerIdRef.current = null;
      if (state.phase !== "armed") swallowNextClick();
      apply(null);
      switch (action.kind) {
        case "reorder":
          live.onReorder(state.start.index, action.index);
          break;
        case "move":
          live.onMove(state.start.tabId, state.start.taskId, action.label, action.index);
          break;
        case "dock":
          live.onDock(state.start.tabId, state.start.taskId);
          break;
        case "tearOff":
          // The machine reports the pointer in client px; the new window is
          // placed in logical screen px, so the tracked screen point wins.
          live.onTearOff(state.start.tabId, state.start.taskId, { ...screenRef.current });
          break;
        case "none":
          break;
      }
      if (torn && live.dragEnd) void live.dragEnd().catch(() => {});
    },
    [apply, swallowNextClick],
  );

  /** While torn, ask the native side what is under the pointer — at most once
   *  per frame, and only for a gesture that is still running. */
  const scheduleHitTest = useCallback(() => {
    if (hitFrameRef.current || !optionsRef.current.hitTest) return;
    hitFrameRef.current = requestAnimationFrame(() => {
      hitFrameRef.current = 0;
      const live = dragRef.current;
      const hitTest = optionsRef.current.hitTest;
      if (!live || live.phase !== "torn" || !hitTest) return;
      const ratio = window.devicePixelRatio || 1;
      const at = screenRef.current;
      void hitTest(at.x * ratio, at.y * ratio)
        .then((hit) => {
          const current = dragRef.current;
          if (!current || current.phase !== "torn") return;
          apply(retarget(current, hit));
        })
        .catch(() => {});
    });
  }, [apply]);

  const handlersFor = useCallback(
    (tabId: string, index: number): TabDragHandlers => ({
      onPointerDown(event) {
        // Left button only: middle-click closes a tab and right-click is the
        // context menu, and both keep their own handlers.
        if (event.button !== 0) return;
        if (isNoDrag(event.target)) return;
        const tab = optionsRef.current.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) return;
        capturePointer(event.currentTarget, event.pointerId, true);
        pointerIdRef.current = event.pointerId;
        screenRef.current = { x: event.screenX, y: event.screenY };
        apply(
          arm({
            tabId,
            taskId: tab.taskId,
            groupId: tab.groupId,
            origin: optionsRef.current.origin,
            index,
            x: event.clientX,
            y: event.clientY,
          }),
        );
      },
      onPointerMove(event) {
        const live = dragRef.current;
        if (!live || pointerIdRef.current !== event.pointerId) return;
        screenRef.current = { x: event.screenX, y: event.screenY };
        const next = move(live, event.clientX, event.clientY, {
          stripRects: measureStrip(),
          groupSpan: optionsRef.current.groupSpanFor(live.start.tabId),
          originClient: { width: window.innerWidth, height: window.innerHeight },
        });
        apply(next);
        if (next.phase === "torn") scheduleHitTest();
      },
      onPointerUp(event) {
        const live = dragRef.current;
        if (!live || pointerIdRef.current !== event.pointerId) return;
        capturePointer(event.currentTarget, event.pointerId, false);
        finish(live, drop(live));
      },
      onPointerCancel(event) {
        const live = dragRef.current;
        if (!live || pointerIdRef.current !== event.pointerId) return;
        capturePointer(event.currentTarget, event.pointerId, false);
        finish(live, cancel(live));
      },
    }),
    [apply, finish, measureStrip, scheduleHitTest],
  );

  const active = drag !== null && drag.phase !== "armed";

  // Escape puts the tab back where it was.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const live = dragRef.current;
      if (!live) return;
      event.preventDefault();
      finish(live, cancel(live));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, finish]);

  // A CSS hook for everything that should hold still while a tab is in the air.
  useEffect(() => {
    if (!active) return;
    document.body.dataset.tabDragging = "true";
    return () => {
      delete document.body.dataset.tabDragging;
    };
  }, [active]);

  useEffect(
    () => () => {
      if (hitFrameRef.current) cancelAnimationFrame(hitFrameRef.current);
      const swallow = swallowRef.current;
      if (swallow) window.removeEventListener("click", swallow, { capture: true });
    },
    [],
  );

  const dragged = drag ? options.tabs.find((tab) => tab.id === drag.start.tabId) : undefined;
  const ghost =
    active && drag ? (
      <div
        className="browser-tab-ghost"
        data-torn={drag.phase === "torn" ? "true" : undefined}
        style={{
          position: "fixed",
          left: drag.pointer.x,
          top: drag.pointer.y,
          pointerEvents: "none",
        }}
        aria-hidden="true"
      >
        <TabFavicon src={dragged?.favicon} />
        <span className="browser-tab-ghost-title">{dragged?.title ?? ""}</span>
      </div>
    ) : null;

  return {
    handlersFor,
    dragging: active,
    draggingTabId: active && drag ? drag.start.tabId : null,
    hoverIndex: drag?.hoverIndex ?? null,
    ghost,
  };
}
