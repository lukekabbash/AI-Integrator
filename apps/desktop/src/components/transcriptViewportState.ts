export interface TranscriptAnchor {
  eventId: string;
  offsetPx: number;
}

export interface TranscriptViewportState {
  anchor?: TranscriptAnchor;
  following: boolean;
  expanded: Record<string, boolean>;
  updatedAt: number;
}

const STORAGE_KEY = "ai-integrator.transcript-view.v1";
const MAX_STORED_TRANSCRIPTS = 80;

type StoredTranscriptViews = Record<string, TranscriptViewportState>;

export function readTranscriptViewportState(
  ownerKey?: string,
): TranscriptViewportState | undefined {
  if (!ownerKey || typeof localStorage === "undefined") return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as StoredTranscriptViews;
    const state = stored[ownerKey];
    if (!state || typeof state.following !== "boolean" || typeof state.updatedAt !== "number") {
      return undefined;
    }
    return {
      anchor:
        state.anchor &&
        typeof state.anchor.eventId === "string" &&
        typeof state.anchor.offsetPx === "number"
          ? state.anchor
          : undefined,
      following: state.following,
      expanded: state.expanded && typeof state.expanded === "object" ? state.expanded : {},
      updatedAt: state.updatedAt,
    };
  } catch {
    return undefined;
  }
}

export function writeTranscriptViewportState(
  ownerKey: string | undefined,
  state: TranscriptViewportState,
): void {
  if (!ownerKey || typeof localStorage === "undefined") return;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as StoredTranscriptViews;
    stored[ownerKey] = state;
    const entries = Object.entries(stored).sort(
      (left, right) => right[1].updatedAt - left[1].updatedAt,
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(0, MAX_STORED_TRANSCRIPTS))),
    );
  } catch {
    // View state is a local convenience; storage failure must never affect the transcript.
  }
}
