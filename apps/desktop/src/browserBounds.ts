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
  ): Promise<void>;
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
}

interface PlacementLane {
  sending: boolean;
  pending?: PendingPlacement;
}

/** Retains the newest geometry independently for every intentional host slot. */
export class BrowserBoundsCoordinator {
  private readonly lanes = new Map<BrowserPlacementSlot, PlacementLane>();

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
    const lane = this.lanes.get(placementSlot) ?? { sending: false };
    lane.pending = { taskId, tabId, bounds, placementSlot };
    this.lanes.set(placementSlot, lane);
    this.drain(placementSlot);
  }

  private drain(placementSlot: BrowserPlacementSlot): void {
    const lane = this.lanes.get(placementSlot);
    if (!lane || lane.sending || !lane.pending) return;
    const placement = lane.pending;
    lane.pending = undefined;
    lane.sending = true;
    void this.writer
      .setBounds(
        placement.taskId,
        placement.tabId,
        placement.bounds,
        placement.placementSlot,
        this.poppedOutHost,
      )
      .catch(() => undefined)
      .finally(() => {
        lane.sending = false;
        this.drain(placementSlot);
      });
  }
}
