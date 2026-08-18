import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { bridge, openExternalLink, type BrowserTab } from "./bridge";
import { annotationAttachmentName } from "./browserAnnotation";
import {
  BrowserBoundsCoordinator,
  toNativeBrowserBounds,
  type BrowserPlacementSlot,
  type BrowserBoundsWriter,
} from "./browserBounds";
import { browserPosters } from "./browserPosters";

/** A picked element, as the guest runtime describes it. */
export interface PickedElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserController {
  available: boolean;
  ready: boolean;
  taskId: string | null;
  allowExternalOpen: boolean;
  tabs: BrowserTab[];
  byId: Record<string, BrowserTab>;
  /** Data URL of the last still taken of each tab, for the tabs that have one.
   *  A slot paints it under the native page so a switch shows the page rather
   *  than the app's own background while the webview is on its way. */
  posters: Readonly<Record<string, string>>;
  message: string | null;
  recordingTabId: string | null;
  annotatingTabId: string | null;
  open: (url?: string) => Promise<BrowserTab | null>;
  /** Closes an idle/user tab; false means recent agent work was preserved. */
  close: (tabId: string) => Promise<boolean>;
  navigate: (tabId: string, url: string) => Promise<void>;
  history: (tabId: string, action: "back" | "forward" | "reload" | "stop") => Promise<void>;
  setBounds: (tabId: string, rect: DOMRect | null, placementSlot: BrowserPlacementSlot) => void;
  setPoppedOut: (tabId: string, popped: boolean) => Promise<void>;
  openExternally: (tabId: string) => Promise<void>;
  /** Remembers the login on the page in this tab, natively. */
  saveLogin: (tabId: string, taskId: string) => Promise<void>;
  /** Types a saved login into this tab. The value never reaches this window. */
  fillLogin: (tabId: string, taskId: string) => Promise<void>;
  screenshot: (tabId: string) => Promise<void>;
  toggleRecording: (tabId: string) => Promise<void>;
  toggleAnnotate: (tabId: string) => Promise<void>;
  setToolbarTooltip: (tabId: string, tooltip: { label: string; x: number } | null) => Promise<void>;
}

export interface BrowserHost {
  /** Attaches a PNG to the composer, e.g. a screenshot or an annotation crop. */
  attachImage: (file: Blob, name: string, taskId: string) => Promise<void>;
  /** Puts text into the composer, e.g. an annotated element's context. */
  insertText: (text: string, taskId: string) => void;
}

export interface BrowserControllerOptions {
  /** The only task whose tabs this renderer instance may observe or control. */
  taskId?: string | null;
  /** External-browser handoff is an explicit Browser setting, off by default. */
  allowExternalOpen?: boolean;
  /** Whether this controller is rendered inside the task's popout window. */
  poppedOutHost?: boolean;
}

export interface BrowserTaskRequest {
  taskId: string;
  tabId: string;
}

/** One task may react only to requests for a tab in its own scoped snapshot. */
export function browserRequestBelongsToTask(
  taskId: string | null,
  tabs: BrowserTab[],
  request: BrowserTaskRequest,
): boolean {
  return (
    request.taskId === taskId &&
    tabs.some((tab) => tab.id === request.tabId && tab.taskId === taskId)
  );
}

/** Rough luminance read of the app's own canvas, for themes that do not say. */
function isDarkCanvas(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (hex) {
    const value = Number.parseInt(hex, 16);
    const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    return (r * 299 + g * 587 + b * 114) / 1000 < 128;
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(color);
  if (!rgb) return true;
  const [r = 0, g = 0, b = 0] = rgb[1].split(",").map((part) => Number.parseFloat(part));
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

/**
 * The overlay the guest draws lives in a page we do not control, so it cannot
 * inherit the app's stylesheet. Resolve the tokens it needs here and hand them
 * over, so the picker, its note box, the agent cursor and the page's own
 * scrollbar wear the user's theme rather than a hardcoded dark card.
 */
function pageTheme(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  // Sites get the app's mode and its scrollbar, so a page inside a dark
  // Integrator does not come up with a white gutter down the side.
  const dark =
    document.documentElement.dataset.theme?.includes("light") === false ||
    style.getPropertyValue("--color-scheme").trim() === "dark" ||
    isDarkCanvas(token("--color-canvas", "#101216"));
  return {
    scheme: dark ? "dark" : "light",
    scrollThumb: token(
      "--color-scrollbar-thumb",
      dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.22)",
    ),
    scrollThumbHover: token(
      "--color-scrollbar-thumb-hover",
      dark ? "rgba(255,255,255,.34)" : "rgba(0,0,0,.34)",
    ),
    accent: token("--color-accent", "#4c8dff"),
    accentInk: token("--color-accent-contrast", "#ffffff"),
    surface: token("--color-elevated", token("--color-layer-1", "#16191d")),
    ink: token("--color-text-primary", "#e7ebf0"),
    muted: token("--color-text-muted", "#96a0ab"),
    line: token("--color-border-subtle", "rgba(255,255,255,.14)"),
    field: token("--color-canvas", "rgba(255,255,255,.05)"),
    radius: token("--radius-row", "10px"),
    font: token("--font-sans", "ui-sans-serif, system-ui, sans-serif"),
  };
}

const RECORDING_INTERVAL_MS = 700;
const RECORDING_MAX_FRAMES = 600;
const NO_BROWSER_TABS: BrowserTab[] = [];

interface ActiveRecording {
  timer: number;
  frames: string[];
  taskId: string;
  tabId: string;
}

interface ActivePicker {
  timer: number;
  taskId: string;
  tabId: string;
}

function pngBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/png" });
}

/**
 * Owns the native browser tabs for this window: their state, the rectangle
 * each one is pinned to, and the capture/annotate flows that end in the
 * composer. Tabs outlive the pane, so nothing here closes a tab implicitly.
 */
export function useBrowserTabs(
  host: BrowserHost,
  {
    taskId: requestedTaskId,
    allowExternalOpen = false,
    poppedOutHost = false,
  }: BrowserControllerOptions,
): BrowserController {
  const api = bridge.browser;
  const taskId = requestedTaskId?.trim() || null;
  const [tabSnapshot, setTabSnapshot] = useState<{
    taskId: string | null;
    tabs: BrowserTab[];
    ready: boolean;
  }>({ taskId: null, tabs: [], ready: !api });
  const [messageSnapshot, setMessageSnapshot] = useState<{
    taskId: string;
    text: string;
  } | null>(null);
  const [recordingState, setRecordingState] = useState<{
    taskId: string;
    tabId: string;
  } | null>(null);
  const [annotatingState, setAnnotatingState] = useState<{
    taskId: string;
    tabId: string;
  } | null>(null);
  const boundsCoordinator = useMemo(
    () => {
      if (!api || !taskId) return null;
      const writer: BrowserBoundsWriter = {
        setBounds: async (...placement) => {
          await api.setBounds(...placement);
          // Only when a tab leaves a slot. The native side takes its still
          // while it is on screen, so parking is the moment this window's copy
          // of it went stale — and it is rare, unlike the rectangles a pane
          // drag sends, none of which change the picture.
          const [writeTaskId, tabId, bounds] = placement;
          if (bounds === null) browserPosters.refresh(api, writeTaskId, tabId);
        },
      };
      return new BrowserBoundsCoordinator(writer, poppedOutHost);
    },
    // A different chat gets a fresh lane immediately; a slow placement from
    // the previous chat must never hold up the browser the user just opened.
    [api, poppedOutHost, taskId],
  );
  const recorder = useRef<ActiveRecording | null>(null);
  const picker = useRef<ActivePicker | null>(null);
  const hostRef = useRef(host);
  useEffect(() => {
    hostRef.current = host;
  });

  useEffect(() => {
    if (!api || !taskId) return;
    let active = true;
    const accept = (tabs: BrowserTab[]) => {
      if (active) setTabSnapshot({ taskId, tabs, ready: true });
    };
    const refresh = () => {
      void api
        .list(taskId)
        .then(accept)
        .catch(() => active && setTabSnapshot({ taskId, tabs: [], ready: true }));
    };
    void api.restore(taskId).then(accept).catch(refresh);
    const unlisten = api.subscribe(refresh);
    return () => {
      active = false;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, [api, taskId]);

  const tabs = tabSnapshot.taskId === taskId ? tabSnapshot.tabs : NO_BROWSER_TABS;
  const ready = !api || !taskId || (tabSnapshot.taskId === taskId && tabSnapshot.ready);
  const message = messageSnapshot?.taskId === taskId ? messageSnapshot.text : null;
  const activeRecordingTabId = recordingState?.taskId === taskId ? recordingState.tabId : null;
  const activeAnnotatingTabId = annotatingState?.taskId === taskId ? annotatingState.tabId : null;

  // One still per open tab, kept for the slots that paint under a native page.
  // A tab that has moved on to another address is asked again; a tab that has
  // closed is forgotten, which is what keeps this window's copy bounded.
  const posters = useSyncExternalStore(browserPosters.subscribe, browserPosters.snapshot);
  useEffect(() => {
    browserPosters.sync(api ?? null, taskId, tabs);
  }, [api, tabs, taskId]);

  // A capture belongs to the task that started it. Stop its timers when that
  // task leaves this renderer so an old page can never write into the next
  // chat's composer. Tabs themselves still persist.
  useEffect(() => {
    return () => {
      if (recorder.current?.taskId === taskId) {
        window.clearInterval(recorder.current.timer);
        recorder.current = null;
        setRecordingState((current) => (current?.taskId === taskId ? null : current));
      }
      if (picker.current?.taskId === taskId) {
        const activePicker = picker.current;
        window.clearInterval(activePicker.timer);
        picker.current = null;
        setAnnotatingState((current) => (current?.taskId === taskId ? null : current));
        if (api && taskId) {
          void api.invoke(taskId, activePicker.tabId, "cancelPick").catch(() => undefined);
        }
      }
    };
  }, [api, taskId]);

  // Hand each tab the app's tokens once it exists, so the agent cursor and the
  // picker are drawn in the user's accent rather than a stock blue. A page can
  // navigate away and drop the overlay, so this re-sends on every tab change;
  // the guest treats it as idempotent.
  const themed = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!api || !taskId) return;
    for (const tab of tabs) {
      const key = `${tab.id}:${tab.url}`;
      if (themed.current.has(key)) continue;
      themed.current.add(key);
      void api.invoke(taskId, tab.id, "setTheme", [pageTheme()]).catch(() => undefined);
    }
  }, [api, tabs, taskId]);

  const setTaskMessage = useCallback((messageTaskId: string, text: string | null) => {
    setMessageSnapshot((current) => {
      if (text !== null) return { taskId: messageTaskId, text };
      return current?.taskId === messageTaskId ? null : current;
    });
  }, []);
  const report = useCallback(
    (messageTaskId: string, error: unknown, fallback: string) =>
      setTaskMessage(messageTaskId, error instanceof Error ? error.message : fallback),
    [setTaskMessage],
  );

  const setBounds = useCallback(
    (tabId: string, rect: DOMRect | null, placementSlot: BrowserPlacementSlot) => {
      if (!boundsCoordinator || !taskId) return;
      if (!rect) {
        boundsCoordinator.place(taskId, tabId, null, placementSlot);
        return;
      }
      boundsCoordinator.place(
        taskId,
        tabId,
        toNativeBrowserBounds(rect, window.devicePixelRatio || 1),
        placementSlot,
      );
    },
    [boundsCoordinator, taskId],
  );

  const screenshot = useCallback(
    async (tabId: string) => {
      if (!api || !taskId) return;
      setTaskMessage(taskId, null);
      try {
        const base64 = await api.screenshot(taskId, tabId);
        await hostRef.current.attachImage(pngBlob(base64), `browser-${Date.now()}.png`, taskId);
        setTaskMessage(taskId, "Screenshot attached to the composer.");
      } catch (error) {
        report(taskId, error, "Could not capture that page.");
      }
    },
    [api, report, setTaskMessage, taskId],
  );

  const stopRecording = useCallback(
    async (expected?: ActiveRecording) => {
      const recording = recorder.current;
      if (!recording || (expected && recording !== expected)) return;
      window.clearInterval(recording.timer);
      const frames = recording.frames;
      recorder.current = null;
      setRecordingState((current) => (current?.taskId === recording.taskId ? null : current));
      if (frames.length === 0) return;
      // The last frame is the artifact the composer can carry today; the rest
      // stay in memory only, so a long recording cannot grow without bound.
      await hostRef.current.attachImage(
        pngBlob(frames[frames.length - 1]),
        `browser-recording-${Date.now()}.png`,
        recording.taskId,
      );
      setTaskMessage(
        recording.taskId,
        `Recording stopped after ${frames.length} frames; last frame attached.`,
      );
    },
    [setTaskMessage],
  );

  const toggleRecording = useCallback(
    async (tabId: string) => {
      if (!api || !taskId) return;
      if (recorder.current) {
        await stopRecording();
        return;
      }
      setTaskMessage(taskId, null);
      const recording: ActiveRecording = { timer: 0, frames: [], taskId, tabId };
      recording.timer = window.setInterval(() => {
        void api
          .screenshot(taskId, tabId)
          .then((frame) => {
            if (recorder.current !== recording) return;
            recording.frames.push(frame);
            if (recording.frames.length >= RECORDING_MAX_FRAMES) {
              void stopRecording(recording);
            }
          })
          .catch(() => undefined);
      }, RECORDING_INTERVAL_MS);
      recorder.current = recording;
      setRecordingState({ taskId, tabId });
      setTaskMessage(taskId, "Recording this tab.");
    },
    [api, setTaskMessage, stopRecording, taskId],
  );

  const toggleAnnotate = useCallback(
    async (tabId: string) => {
      if (!api || !taskId) return;
      if (picker.current) {
        const activePicker = picker.current;
        window.clearInterval(activePicker.timer);
        picker.current = null;
        setAnnotatingState((current) => (current?.taskId === activePicker.taskId ? null : current));
        await api
          .invoke(activePicker.taskId, activePicker.tabId, "cancelPick")
          .catch(() => undefined);
        return;
      }
      setTaskMessage(taskId, null);
      try {
        await api.invoke(taskId, tabId, "startPick", [pageTheme()]);
        setAnnotatingState({ taskId, tabId });
        const activePicker: ActivePicker = { timer: 0, taskId, tabId };
        activePicker.timer = window.setInterval(() => {
          void api
            .invoke(taskId, tabId, "pickResult")
            .then(async (raw) => {
              if (picker.current !== activePicker) return;
              const result = raw as {
                picking: boolean;
                picked: PickedElement | null;
                comment?: string;
                cancelled: boolean;
              };
              if (result.picking) return;
              window.clearInterval(activePicker.timer);
              picker.current = null;
              setAnnotatingState((current) => (current?.taskId === taskId ? null : current));
              if (!result.picked) return;
              const tab = tabs.find((candidate) => candidate.id === tabId);
              const picked = result.picked;
              await api
                .invoke(taskId, tabId, "annotate", [
                  [{ kind: "element", ref: picked.ref, label: picked.name }],
                ])
                .catch(() => undefined);
              try {
                const base64 = await api.screenshot(taskId, tabId);
                await hostRef.current.attachImage(
                  pngBlob(base64),
                  annotationAttachmentName(picked.name || picked.tag),
                  taskId,
                );
              } catch {
                // The context below still stands on its own without the image.
              }
              await api.invoke(taskId, tabId, "clearAnnotations").catch(() => undefined);
              hostRef.current.insertText(
                [
                  "<browser_annotation>",
                  `Page: ${tab?.title || tab?.url || "Browser tab"}`,
                  `URL: ${tab?.url ?? ""}`,
                  `Element: <${picked.tag}> role=${picked.role || "none"}${
                    picked.name ? ` name=${JSON.stringify(picked.name)}` : ""
                  }`,
                  `Selector: ${picked.selector}`,
                  ...((result.comment ?? "").trim()
                    ? ["Note:", (result.comment ?? "").trim()]
                    : []),
                  "</browser_annotation>",
                  "",
                ].join("\n"),
                taskId,
              );
            })
            .catch(() => undefined);
        }, 250);
        picker.current = activePicker;
      } catch (error) {
        report(taskId, error, "Could not start annotating that page.");
      }
    },
    [api, report, setTaskMessage, tabs, taskId],
  );

  return useMemo<BrowserController>(() => {
    const byId: Record<string, BrowserTab> = {};
    for (const tab of tabs) byId[tab.id] = tab;
    return {
      available: Boolean(api),
      ready,
      taskId,
      allowExternalOpen,
      tabs,
      byId,
      posters,
      message,
      recordingTabId: activeRecordingTabId,
      annotatingTabId: activeAnnotatingTabId,
      open: async (url) => {
        if (!api || !taskId) return null;
        setTaskMessage(taskId, null);
        try {
          return await api.open(taskId, url);
        } catch (error) {
          report(taskId, error, "Could not open a browser tab.");
          return null;
        }
      },
      close: async (tabId) => {
        if (!api || !taskId || !byId[tabId]) return false;
        try {
          return await api.close(taskId, tabId);
        } catch (error) {
          report(taskId, error, "Could not close that tab.");
          return false;
        }
      },
      navigate: async (tabId, url) => {
        if (!api || !taskId || !byId[tabId]) return;
        setTaskMessage(taskId, null);
        await api
          .navigate(taskId, tabId, url)
          .catch((error) => report(taskId, error, "Could not open that URL."));
      },
      history: async (tabId, action) => {
        if (!api || !taskId || !byId[tabId]) return;
        await api.history(taskId, tabId, action).catch(() => undefined);
      },
      setBounds,
      setPoppedOut: async (tabId, popped) => {
        // A just-created tab can be moved before the changed event has put it
        // in `byId`; native task scoping remains the source of truth.
        if (!api || !taskId) return;
        await api
          .setPoppedOut(taskId, tabId, popped)
          .catch((error) => report(taskId, error, "Could not move that tab."));
      },
      openExternally: async (tabId) => {
        if (!allowExternalOpen) {
          if (taskId) {
            setTaskMessage(
              taskId,
              "Opening tabs in an external browser is turned off in Settings → Browser.",
            );
          }
          return;
        }
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (tab?.url) await openExternalLink(tab.url).catch(() => undefined);
      },
      // Both of these are one native call and a message: the password moves
      // between the page and the OS credential store without passing through
      // the renderer, so there is nothing here to hold or leak.
      saveLogin: async (tabId, requestedTaskId) => {
        if (!api || !taskId || requestedTaskId !== taskId || !byId[tabId]) return;
        setTaskMessage(taskId, null);
        try {
          const saved = await api.saveLogin(tabId, taskId);
          if (saved) {
            setTaskMessage(taskId, `Saved the login for ${saved.username} on ${saved.origin}.`);
          }
        } catch (error) {
          report(taskId, error, "Could not save that login.");
        }
      },
      fillLogin: async (tabId, requestedTaskId) => {
        if (!api || !taskId || requestedTaskId !== taskId || !byId[tabId]) return;
        setTaskMessage(taskId, null);
        try {
          await api.fillLogin(tabId, taskId);
        } catch (error) {
          report(taskId, error, "Could not sign in with a saved login.");
        }
      },
      screenshot,
      toggleRecording,
      toggleAnnotate,
      setToolbarTooltip: async (tabId, tooltip) => {
        if (!api || !taskId || !byId[tabId]) return;
        await api.invoke(taskId, tabId, "hostTooltip", [tooltip]).catch(() => undefined);
      },
    };
  }, [
    api,
    ready,
    taskId,
    allowExternalOpen,
    tabs,
    posters,
    message,
    activeRecordingTabId,
    activeAnnotatingTabId,
    setBounds,
    screenshot,
    toggleRecording,
    toggleAnnotate,
    report,
    setTaskMessage,
  ]);
}
