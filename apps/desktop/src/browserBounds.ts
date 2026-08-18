export interface NativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One native host can deliberately show a pane and a compact card together. */
export type BrowserPlacementSlot = "pane" | "deck" | "popout";

export interface BrowserBoundsWriter {
  setBounds(
    taskId: string,
    tabId: string,
    bounds: NativeBrowserBounds | null,
    placementSlot: BrowserPlacementSlot,
    poppedOutHost: boolean,
    placementSession: number,
    placementRevision: number,
  ): Promise<void>;
}

interface PlacementClock {
  session: number;
  revision: number;
}

declare global {
  // Kept on the window so Vite hot reload cannot wind the native ordering
  // clock backwards while the Rust process and its browser tabs stay alive.
  var __integratorBrowserPlacementClock: PlacementClock | undefined;
}

function placementClock(): PlacementClock {
  if (!globalThis.__integratorBrowserPlacementClock) {
    const timeOrigin =
      typeof performance === "undefined" ? Date.now() : Math.round(performance.timeOrigin);
    // Milliseconds leave enough safe-integer room for a per-session sequence.
    globalThis.__integratorBrowserPlacementClock = { session: timeOrigin, revision: 0 };
  }
  return globalThis.__integratorBrowserPlacementClock;
}

function nextPlacementOrder(): Pick<PendingPlacement, "session" | "revision"> {
  const clock = placementClock();
  clock.revision += 1;
  return { session: clock.session, revision: clock.revision };
}

/** Rounds both edges so fractional scaling cannot grow or shrink the slot. */
export function toNativeBrowserBounds(
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  devicePixelRatio: number,
): NativeBrowserBounds {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const x = Math.round(rect.left * ratio);
  const y = Math.round(rect.top * ratio);
  const right = Math.round(rect.right * ratio);
  const bottom = Math.round(rect.bottom * ratio);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

interface PendingPlacement {
  taskId: string;
  tabId: string;
  bounds: NativeBrowserBounds | null;
  placementSlot: BrowserPlacementSlot;
  session: number;
  revision: number;
}

interface PlacementLane {
  scheduled: boolean;
  lastOwner?: string;
  inFlight: Map<number, string>;
  pending?: PendingPlacement;
}

/** The pane and popout each hold one page; the deck shows every card at once,
 *  so each deck tab is its own lane rather than the newest card starving the
 *  others of their geometry. */
function laneKey(placementSlot: BrowserPlacementSlot, tabId: string): string {
  return placementSlot === "deck" ? `deck\0${tabId}` : placementSlot;
}

/** Retains the newest geometry independently for every intentional host slot. */
export class BrowserBoundsCoordinator {
  private readonly lanes = new Map<string, PlacementLane>();

  constructor(
    private readonly writer: BrowserBoundsWriter,
    private readonly poppedOutHost: boolean,
  ) {}

  place(
    taskId: string,
    tabId: string,
    bounds: NativeBrowserBounds | null,
    placementSlot: BrowserPlacementSlot,
  ): void {
    const key = laneKey(placementSlot, tabId);
    const lane = this.lanes.get(key) ?? {
      scheduled: false,
      inFlight: new Map<number, string>(),
    };
    lane.pending = { taskId, tabId, bounds, placementSlot, ...nextPlacementOrder() };
    this.lanes.set(key, lane);
    this.schedule(key);
  }

  /**
   * React retires the old tab and mounts the new one in the same commit. Let
   * that commit finish before starting IPC so `old → hidden → new → visible`
   * becomes one direct `new → visible` placement. The native side parks the
   * previous owner of the slot atomically while exposing the replacement.
   */
  private schedule(key: string): void {
    const lane = this.lanes.get(key);
    if (!lane || lane.scheduled || !lane.pending) return;
    lane.scheduled = true;
    queueMicrotask(() => {
      lane.scheduled = false;
      this.drain(key);
    });
  }

  private drain(key: string): void {
    const lane = this.lanes.get(key);
    if (!lane || !lane.pending) return;
    const placement = lane.pending;
    const owner = `${placement.taskId}\0${placement.tabId}\0${placement.bounds ? "shown" : "hidden"}`;
    const sameOwnerInFlight = [...lane.inFlight.values()].some(
      (inFlightOwner) => inFlightOwner === owner,
    );
    // Resize traffic for one live page stays serialized and newest-only. An
    // ownership change is different: send it at once so its newer native claim
    // can invalidate a slow wake/placement from the tab or chat being left.
    if (lane.lastOwner === owner && sameOwnerInFlight) return;
    lane.pending = undefined;
    lane.lastOwner = owner;
    lane.inFlight.set(placement.revision, owner);
    void this.writer
      .setBounds(
        placement.taskId,
        placement.tabId,
        placement.bounds,
        placement.placementSlot,
        this.poppedOutHost,
        placement.session,
        placement.revision,
      )
      .catch(() => undefined)
      .finally(() => {
        lane.inFlight.delete(placement.revision);
        this.schedule(key);
      });
  }
}
