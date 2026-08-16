import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { bridge, openExternalLink, type BrowserTab } from "./bridge";
import { annotationAttachmentName } from "./browserAnnotation";

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
  tabs: BrowserTab[];
  byId: Record<string, BrowserTab>;
  message: string | null;
  recordingTabId: string | null;
  annotatingTabId: string | null;
  open: (taskId: string, url?: string) => Promise<BrowserTab | null>;
  close: (tabId: string) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  history: (tabId: string, action: "back" | "forward" | "reload" | "stop") => Promise<void>;
  setBounds: (tabId: string, rect: DOMRect | null) => void;
  setPoppedOut: (tabId: string, popped: boolean) => Promise<void>;
  openExternally: (tabId: string) => Promise<void>;
  screenshot: (tabId: string) => Promise<void>;
  toggleRecording: (tabId: string) => Promise<void>;
  toggleAnnotate: (tabId: string) => Promise<void>;
}

export interface BrowserHost {
  /** Attaches a PNG to the composer, e.g. a screenshot or an annotation crop. */
  attachImage: (file: Blob, name: string) => Promise<void>;
  /** Puts text into the composer, e.g. an annotated element's context. */
  insertText: (text: string) => void;
}

const RECORDING_INTERVAL_MS = 700;
const RECORDING_MAX_FRAMES = 600;

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
export function useBrowserTabs(host: BrowserHost): BrowserController {
  const api = bridge.browser;
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [recordingTabId, setRecordingTabId] = useState<string | null>(null);
  const [annotatingTabId, setAnnotatingTabId] = useState<string | null>(null);
  const boundsFrame = useRef<number>(0);
  const recorder = useRef<{ timer: number; frames: string[] } | null>(null);
  const picker = useRef<number | null>(null);
  const hostRef = useRef(host);
  useEffect(() => {
    hostRef.current = host;
  });

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .list()
      .then((next) => active && setTabs(next))
      .catch(() => undefined);
    const unlisten = api.subscribe((next) => active && setTabs(next));
    return () => {
      active = false;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, [api]);

  // Stop background work when the window goes away; tabs themselves persist.
  useEffect(
    () => () => {
      if (recorder.current) window.clearInterval(recorder.current.timer);
      if (picker.current) window.clearInterval(picker.current);
    },
    [],
  );

  const report = useCallback(
    (error: unknown, fallback: string) =>
      setMessage(error instanceof Error ? error.message : fallback),
    [],
  );

  const setBounds = useCallback(
    (tabId: string, rect: DOMRect | null) => {
      if (!api) return;
      cancelAnimationFrame(boundsFrame.current);
      boundsFrame.current = requestAnimationFrame(() => {
        const ratio = window.devicePixelRatio || 1;
        void api
          .setBounds(
            tabId,
            rect
              ? {
                  x: Math.round(rect.x * ratio),
                  y: Math.round(rect.y * ratio),
                  width: Math.round(rect.width * ratio),
                  height: Math.round(rect.height * ratio),
                }
              : null,
          )
          .catch(() => undefined);
      });
    },
    [api],
  );

  const screenshot = useCallback(
    async (tabId: string) => {
      if (!api) return;
      setMessage(null);
      try {
        const base64 = await api.screenshot(tabId);
        await hostRef.current.attachImage(pngBlob(base64), `browser-${Date.now()}.png`);
        setMessage("Screenshot attached to the composer.");
      } catch (error) {
        report(error, "Could not capture that page.");
      }
    },
    [api, report],
  );

  const stopRecording = useCallback(async () => {
    if (!recorder.current) return;
    window.clearInterval(recorder.current.timer);
    const frames = recorder.current.frames;
    recorder.current = null;
    setRecordingTabId(null);
    if (frames.length === 0) return;
    // The last frame is the artifact the composer can carry today; the rest
    // stay in memory only, so a long recording cannot grow without bound.
    await hostRef.current.attachImage(
      pngBlob(frames[frames.length - 1]),
      `browser-recording-${Date.now()}.png`,
    );
    setMessage(`Recording stopped after ${frames.length} frames; last frame attached.`);
  }, []);

  const toggleRecording = useCallback(
    async (tabId: string) => {
      if (!api) return;
      if (recorder.current) {
        await stopRecording();
        return;
      }
      setMessage(null);
      const frames: string[] = [];
      const timer = window.setInterval(() => {
        void api
          .screenshot(tabId)
          .then((frame) => {
            frames.push(frame);
            if (frames.length >= RECORDING_MAX_FRAMES) void stopRecording();
          })
          .catch(() => undefined);
      }, RECORDING_INTERVAL_MS);
      recorder.current = { timer, frames };
      setRecordingTabId(tabId);
      setMessage("Recording this tab.");
    },
    [api, stopRecording],
  );

  const toggleAnnotate = useCallback(
    async (tabId: string) => {
      if (!api) return;
      if (picker.current) {
        window.clearInterval(picker.current);
        picker.current = null;
        setAnnotatingTabId(null);
        await api.invoke(tabId, "cancelPick").catch(() => undefined);
        return;
      }
      setMessage(null);
      try {
        await api.invoke(tabId, "startPick", [{ accent: "#4c8dff" }]);
        setAnnotatingTabId(tabId);
        picker.current = window.setInterval(() => {
          void api
            .invoke(tabId, "pickResult")
            .then(async (raw) => {
              const result = raw as {
                picking: boolean;
                picked: PickedElement | null;
                comment?: string;
                cancelled: boolean;
              };
              if (result.picking) return;
              if (picker.current) window.clearInterval(picker.current);
              picker.current = null;
              setAnnotatingTabId(null);
              if (!result.picked) return;
              const tab = tabs.find((candidate) => candidate.id === tabId);
              const picked = result.picked;
              await api
                .invoke(tabId, "annotate", [
                  [{ kind: "element", ref: picked.ref, label: picked.name }],
                ])
                .catch(() => undefined);
              try {
                const base64 = await api.screenshot(tabId);
                await hostRef.current.attachImage(
                  pngBlob(base64),
                  annotationAttachmentName(picked.name || picked.tag),
                );
              } catch {
                // The context below still stands on its own without the image.
              }
              await api.invoke(tabId, "clearAnnotations").catch(() => undefined);
              hostRef.current.insertText(
                [
                  "<browser_annotation>",
                  `Page: ${tab?.title || tab?.url || "Browser tab"}`,
                  `URL: ${tab?.url ?? ""}`,
                  `Element: <${picked.tag}> role=${picked.role || "none"}${
                    picked.name ? ` name=${JSON.stringify(picked.name)}` : ""
                  }`,
                  `Selector: ${picked.selector}`,
                  ...((result.comment ?? "").trim() ? ["Note:", (result.comment ?? "").trim()] : []),
                  "</browser_annotation>",
                  "",
                ].join("\n"),
              );
            })
            .catch(() => undefined);
        }, 250);
      } catch (error) {
        report(error, "Could not start annotating that page.");
      }
    },
    [api, report, tabs],
  );

  return useMemo<BrowserController>(() => {
    const byId: Record<string, BrowserTab> = {};
    for (const tab of tabs) byId[tab.id] = tab;
    return {
      available: Boolean(api),
      tabs,
      byId,
      message,
      recordingTabId,
      annotatingTabId,
      open: async (taskId, url) => {
        if (!api) return null;
        setMessage(null);
        try {
          return await api.open(taskId, url);
        } catch (error) {
          report(error, "Could not open a browser tab.");
          return null;
        }
      },
      close: async (tabId) => {
        await api?.close(tabId).catch((error) => report(error, "Could not close that tab."));
      },
      navigate: async (tabId, url) => {
        setMessage(null);
        await api?.navigate(tabId, url).catch((error) => report(error, "Could not open that URL."));
      },
      history: async (tabId, action) => {
        await api?.history(tabId, action).catch(() => undefined);
      },
      setBounds,
      setPoppedOut: async (tabId, popped) => {
        await api
          ?.setPoppedOut(tabId, popped)
          .catch((error) => report(error, "Could not move that tab."));
      },
      openExternally: async (tabId) => {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (tab?.url) await openExternalLink(tab.url).catch(() => undefined);
      },
      screenshot,
      toggleRecording,
      toggleAnnotate,
    };
  }, [
    api,
    tabs,
    message,
    recordingTabId,
    annotatingTabId,
    setBounds,
    screenshot,
    toggleRecording,
    toggleAnnotate,
    report,
  ]);
}
