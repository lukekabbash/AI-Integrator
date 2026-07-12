import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowUp,
  AtSign,
  FilePlus2,
  Gauge,
  Mic,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
  X,
} from "lucide-react";
import {
  bridge,
  resolveModelEffort,
  runtimeAuthWarning,
  type ModelCatalogEntry,
  type RuntimeConnection,
  type RuntimeId,
} from "../bridge";
import type { ComposerNotice } from "../composerNotices";
import { Dropdown, ProviderIcon } from "./Dropdown";
import { appendVoiceSegment, insertVoiceText, type VoiceInsertAnchor } from "./voiceTyping";

interface ComposerProps {
  runtimes: RuntimeConnection[];
  defaultRuntime: RuntimeId;
  defaultModel: string;
  /** Settings-provided reasoning effort, applied when the model supports it. */
  defaultEffort?: string;
  /** Settings-provided permission profile preselected for new chats. */
  defaultPermission?: "read-only" | "project-write" | "ask" | "full-access";
  /** Settings-provided delegation mode preselected for new chats. */
  defaultDelegation?: "off" | "manual" | "balanced" | "budget-first";
  /** When false, plain Enter inserts a newline and Ctrl/Cmd+Enter sends. */
  enterToSend?: boolean;
  onSend: (value: {
    prompt: string;
    runtime: RuntimeId;
    model: string;
    effort?: string;
    permission: "read-only" | "project-write" | "ask" | "full-access";
    delegation: "off" | "manual" | "balanced" | "budget-first";
  }) => Promise<void>;
  /** Persist provider/model/effort for an existing chat as soon as the user changes them. */
  onRoutingChange?: (value: { runtime: RuntimeId; model: string; effort?: string }) => void;
  /** Opens a caller-owned context picker. Omitted until attachments are persisted with a task. */
  onAddContext?: () => void;
  /** Blocking or actionable runtime feedback docked immediately above the composer. */
  notices?: ComposerNotice[];
  /** True while the active task's turn is in progress; swaps send for stop. */
  running?: boolean;
  /** True once a stop has been requested and is still settling. */
  stopping?: boolean;
  /** Stops the in-progress turn from the send position. */
  onStop?: () => void;
}

interface VoiceCapture {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  sink: GainNode;
}

function normalizeRuntime(runtimes: RuntimeConnection[], desired: RuntimeId): RuntimeId {
  return runtimes.some((item) => item.id === desired) ? desired : (runtimes[0]?.id ?? "codex");
}

type VoicePhase = "idle" | "starting" | "recording" | "stopping";

function encodePcm16(samples: Float32Array, sourceRate: number): number[] {
  const targetRate = 24000;
  const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const bytes = new Array<number>(outputLength * 2);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor((index * sourceRate) / targetRate);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor(((index + 1) * sourceRate) / targetRate)),
    );
    let sum = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) sum += samples[sampleIndex];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    const rounded = Math.round(pcm);
    bytes[index * 2] = rounded & 0xff;
    bytes[index * 2 + 1] = (rounded >> 8) & 0xff;
  }
  return bytes;
}

export function Composer({
  runtimes,
  defaultRuntime,
  defaultModel,
  defaultEffort,
  defaultPermission,
  defaultDelegation,
  enterToSend = true,
  onSend,
  onRoutingChange,
  onAddContext,
  notices = [],
  running = false,
  stopping = false,
  onStop,
}: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [runtime, setRuntime] = useState<RuntimeId>(() =>
    normalizeRuntime(runtimes, defaultRuntime),
  );
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState<string | undefined>(defaultEffort);
  const [permission, setPermission] = useState<
    "read-only" | "project-write" | "ask" | "full-access"
  >(defaultPermission ?? "project-write");
  const [delegation, setDelegation] = useState<"off" | "manual" | "balanced" | "budget-first">(
    defaultDelegation ?? "off",
  );
  const [sending, setSending] = useState(false);
  const [providerCatalogs, setProviderCatalogs] = useState<Record<string, ModelCatalogEntry[]>>({});
  const [voiceConfigured, setVoiceConfigured] = useState<boolean | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceError, setVoiceError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState("default");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceCaptureRef = useRef<VoiceCapture | null>(null);
  const voiceAppendQueueRef = useRef(Promise.resolve());
  const voiceBaseRef = useRef("");
  const voiceAnchorRef = useRef<VoiceInsertAnchor>({ start: 0, end: 0 });
  const voiceCommittedTranscriptRef = useRef("");
  const voiceLiveTranscriptRef = useRef("");
  const voiceSessionActiveRef = useRef(false);
  const voiceNoticeTimerRef = useRef<number | undefined>(undefined);
  const [dismissedNoticeIds, setDismissedNoticeIds] = useState<Set<string>>(new Set());
  const [noticeClock, setNoticeClock] = useState(() => Date.now());
  /** Once the user picks any routing value, settings defaults stop syncing. */
  const routingTouched = useRef(false);
  const selectedRuntime = runtimes.find((item) => item.id === runtime) ?? runtimes[0];
  const catalog =
    providerCatalogs[runtime] ??
    (selectedRuntime?.models.length
      ? selectedRuntime.models.map((id) => ({ id, label: id }))
      : [{ id: "Provider default", label: "Provider default" }]);
  const activeEntry = catalog.find((entry) => entry.id === model) ?? catalog[0];
  const activeModel = activeEntry?.id ?? "Provider default";
  const effortOptions = activeEntry?.efforts ?? [];
  const activeEffort = resolveModelEffort(activeEntry, effort);
  const runtimeWarning = runtimeAuthWarning(selectedRuntime);
  const visibleNotices = notices.filter(
    (notice) =>
      !dismissedNoticeIds.has(notice.id) &&
      (notice.expiresAt === undefined || notice.expiresAt > noticeClock),
  );
  const voiceRecording = voicePhase === "recording";
  const voiceActive = voicePhase !== "idle";

  // Grow the textarea with its content (up to the CSS max-height) instead of
  // scrolling a fixed three-row box.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 170)}px`;
  }, [prompt]);

  useEffect(() => {
    const timeout = notices.reduce<number | undefined>((soonest, notice) => {
      if (dismissedNoticeIds.has(notice.id) || notice.expiresAt === undefined) return soonest;
      if (soonest === undefined || notice.expiresAt < soonest) return notice.expiresAt;
      return soonest;
    }, undefined);
    if (timeout === undefined) return;
    const delay = Math.max(0, timeout - Date.now());
    const timer = window.setTimeout(() => setNoticeClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [dismissedNoticeIds, notices]);

  const emitRoutingChange = (
    nextRuntime: RuntimeId,
    nextModel: string,
    nextEffort: string | undefined,
  ) => {
    onRoutingChange?.({
      runtime: nextRuntime,
      model: nextModel,
      effort: nextEffort,
    });
  };

  // Settings defaults load after the composer mounts on a cold start; keep
  // untouched pickers in sync so persisted defaults actually take effect.
  useEffect(() => {
    if (routingTouched.current) return;
    setRuntime(normalizeRuntime(runtimes, defaultRuntime));
    setModel(defaultModel);
    setPermission(defaultPermission ?? "project-write");
    setEffort(defaultEffort);
  }, [defaultRuntime, defaultModel, defaultPermission, defaultEffort, runtimes]);

  useEffect(() => {
    let active = true;
    const getCredentialStatus = bridge.getVoiceTypingCredentialStatus;
    if (getCredentialStatus) {
      void getCredentialStatus()
        .then((status) => {
          if (active) setVoiceConfigured(status.configured);
        })
        .catch(() => {
          if (active) setVoiceConfigured(false);
        });
    }
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const subscribeVoiceTyping = bridge.subscribeVoiceTyping;
    if (!subscribeVoiceTyping) {
      return () => {
        active = false;
      };
    }
    void subscribeVoiceTyping((event) => {
      if (!active || !voiceSessionActiveRef.current) return;
      if (event.kind === "error") {
        setVoiceError(event.text);
        return;
      }
      if (event.kind === "completed") {
        // A completed event contains the full current utterance, while delta
        // events contain fragments of that same utterance. Keep the committed
        // utterances separate so a new utterance cannot erase earlier words or
        // duplicate its own deltas.
        const completedText = event.text || voiceLiveTranscriptRef.current;
        voiceCommittedTranscriptRef.current = appendVoiceSegment(
          voiceCommittedTranscriptRef.current,
          completedText,
        );
        voiceLiveTranscriptRef.current = "";
      } else {
        voiceLiveTranscriptRef.current += event.text;
      }
      const transcript = appendVoiceSegment(
        voiceCommittedTranscriptRef.current,
        voiceLiveTranscriptRef.current,
      );
      setPrompt(insertVoiceText(voiceBaseRef.current, transcript, voiceAnchorRef.current));
    })
      .then((cleanup) => {
        if (active) unsubscribe = cleanup;
        else cleanup();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  // Device labels are only exposed once microphone permission is granted, so
  // re-enumerate when recording starts as well as on hardware changes.
  useEffect(() => {
    const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    let active = true;
    const refresh = () => {
      void mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (active) setMicDevices(devices.filter((device) => device.kind === "audioinput"));
        })
        .catch(() => undefined);
    };
    refresh();
    mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [voiceRecording]);

  const releaseVoiceCapture = useCallback(async () => {
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = null;
    if (capture) {
      capture.processor.onaudioprocess = null;
      capture.source.disconnect();
      capture.processor.disconnect();
      capture.sink.disconnect();
      capture.stream.getTracks().forEach((track) => track.stop());
      await capture.context.close().catch(() => undefined);
    }
  }, []);

  const stopVoiceTyping = useCallback(async () => {
    if (!voiceActive) return;
    // Clearing the session flag first also aborts a startup still in flight,
    // so a second click on the mic always shuts voice typing off.
    voiceSessionActiveRef.current = false;
    setVoicePhase("stopping");
    await releaseVoiceCapture();
    await voiceAppendQueueRef.current.catch(() => undefined);
    voiceAppendQueueRef.current = Promise.resolve();
    try {
      if (bridge.stopVoiceTyping) await bridge.stopVoiceTyping();
      setVoiceError("");
      setVoiceNotice("Voice text kept in the draft.");
      if (voiceNoticeTimerRef.current !== undefined) {
        window.clearTimeout(voiceNoticeTimerRef.current);
      }
      voiceNoticeTimerRef.current = window.setTimeout(() => {
        setVoiceNotice("");
        voiceNoticeTimerRef.current = undefined;
      }, 4500);
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Could not stop voice typing.");
    } finally {
      setVoicePhase("idle");
    }
  }, [releaseVoiceCapture, voiceActive]);

  useEffect(() => {
    if (!voiceRecording) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void stopVoiceTyping();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stopVoiceTyping, voiceRecording]);

  const startVoiceTyping = async () => {
    if (voicePhase !== "idle") return;
    if (!voiceConfigured) {
      setVoiceError("Add your OpenAI API key in Settings → General to enable voice typing.");
      return;
    }
    if (typeof window === "undefined" || !window.AudioContext || !navigator.mediaDevices) {
      setVoiceError("This desktop environment does not provide microphone capture.");
      return;
    }
    if (!bridge.startVoiceTyping || !bridge.appendVoiceTypingPcm) {
      setVoiceError("Voice typing is unavailable in this app build.");
      return;
    }
    setVoicePhase("starting");
    setVoiceError("");
    setVoiceNotice("");
    voiceBaseRef.current = prompt;
    voiceCommittedTranscriptRef.current = "";
    voiceLiveTranscriptRef.current = "";
    const start = textareaRef.current?.selectionStart ?? prompt.length;
    const end = textareaRef.current?.selectionEnd ?? start;
    voiceAnchorRef.current = { start, end };
    voiceSessionActiveRef.current = true;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          ...(micDeviceId !== "default" ? { deviceId: { exact: micDeviceId } } : {}),
        },
      });
      if (!voiceSessionActiveRef.current) {
        // The mic was clicked again while permission was pending; abort.
        stream.getTracks().forEach((track) => track.stop());
        setVoicePhase("idle");
        return;
      }
      context = new AudioContext({ sampleRate: 24000 });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
      await bridge.startVoiceTyping();
      if (!voiceSessionActiveRef.current) {
        // Cancelled during backend startup; unwind instead of recording.
        stream.getTracks().forEach((track) => track.stop());
        await context.close().catch(() => undefined);
        if (bridge.stopVoiceTyping) await bridge.stopVoiceTyping().catch(() => undefined);
        setVoicePhase("idle");
        return;
      }
      let chunkCount = 0;
      let sawSignal = false;
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        chunkCount += 1;
        if (!sawSignal) {
          for (let index = 0; index < samples.length; index += 1) {
            if (Math.abs(samples[index]) > 0.001) {
              sawSignal = true;
              break;
            }
          }
        }
        const bytes = encodePcm16(samples, context?.sampleRate ?? 24000);
        voiceAppendQueueRef.current = voiceAppendQueueRef.current
          .catch(() => undefined)
          .then(() => bridge.appendVoiceTypingPcm!(bytes))
          .catch((error) => {
            setVoiceError(
              error instanceof Error ? error.message : "Could not send microphone audio.",
            );
          });
      };
      // Capture can fail silently: the audio graph never ticks, or the track
      // delivers only digital silence (wrong device, OS-level mic privacy
      // block). Surface both instead of leaving a mute session running.
      window.setTimeout(() => {
        if (!voiceSessionActiveRef.current) return;
        if (chunkCount === 0) {
          setVoiceError(
            "The microphone is not producing audio. Check Windows microphone privacy settings and the selected device.",
          );
        } else if (!sawSignal) {
          setVoiceError(
            "Only silence is coming from the microphone. Try a different device from the mic dropdown.",
          );
        }
      }, 3000);
      voiceCaptureRef.current = { context, stream, source, processor, sink };
      setVoicePhase("recording");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => undefined);
      if (bridge.stopVoiceTyping) await bridge.stopVoiceTyping().catch(() => undefined);
      voiceSessionActiveRef.current = false;
      setVoiceError(error instanceof Error ? error.message : "Could not start voice typing.");
      setVoicePhase("idle");
    } finally {
      // The phase is the source of truth for the button and status copy.
    }
  };

  useEffect(
    () => () => {
      const capture = voiceCaptureRef.current;
      voiceCaptureRef.current = null;
      if (capture) {
        capture.processor.onaudioprocess = null;
        capture.source.disconnect();
        capture.processor.disconnect();
        capture.sink.disconnect();
        capture.stream.getTracks().forEach((track) => track.stop());
        void capture.context.close().catch(() => undefined);
      }
      voiceSessionActiveRef.current = false;
      if (voiceNoticeTimerRef.current !== undefined) {
        window.clearTimeout(voiceNoticeTimerRef.current);
      }
      if (bridge.stopVoiceTyping) void bridge.stopVoiceTyping().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (providerCatalogs[runtime]) return;
    let active = true;
    void bridge
      .listModelCatalog?.(runtime)
      .then((entries) => {
        if (!active || !entries?.length) return;
        setProviderCatalogs((current) => ({ ...current, [runtime]: entries }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [runtime, providerCatalogs]);

  // A saved model can belong to a different runtime (for example after an
  // imported settings file or a runtime change from an older build). Once the
  // provider catalog resolves, select its first advertised model so the
  // default route is a real, sendable route rather than a stale id.
  useEffect(() => {
    const resolvedCatalog = providerCatalogs[runtime];
    if (!resolvedCatalog?.length || resolvedCatalog.some((entry) => entry.id === model)) return;
    const nextEntry = resolvedCatalog[0];
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setModel(nextEntry.id);
      setEffort(resolveModelEffort(nextEntry, defaultEffort));
    });
    return () => {
      cancelled = true;
    };
  }, [defaultEffort, model, providerCatalogs, runtime]);

  const submit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend({
        prompt: trimmed,
        runtime,
        model: activeModel,
        effort: effortOptions.length > 0 ? activeEffort : undefined,
        permission,
        delegation,
      });
      setPrompt("");
      textareaRef.current?.focus();
    } finally {
      setSending(false);
    }
  };

  const insertMention = () => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? prompt.length;
    const end = textarea?.selectionEnd ?? prompt.length;
    const next = `${prompt.slice(0, start)}@${prompt.slice(end)}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + 1, start + 1);
    });
  };

  return (
    <div className="composer-wrap">
      {visibleNotices.length > 0 ? (
        <div className="composer-notices" aria-label="Composer notices">
          {visibleNotices.map((notice) => (
            <aside
              className={`composer-notice composer-notice--${notice.variant}`}
              key={notice.id}
              role="alert"
            >
              <div className="composer-notice-heading">
                <strong>{notice.title}</strong>
                <button
                  className="composer-notice-dismiss"
                  type="button"
                  aria-label={`Dismiss ${notice.title}`}
                  title="Dismiss notice"
                  onClick={() =>
                    setDismissedNoticeIds((current) => new Set(current).add(notice.id))
                  }
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <p>{notice.message}</p>
            </aside>
          ))}
        </div>
      ) : null}
      <div className="composer" data-busy={sending}>
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => {
            const nextPrompt = event.target.value;
            if (voiceActive) {
              // Treat a manual edit as the new draft baseline. This keeps
              // typed text and already-transcribed words intact instead of
              // rebuilding the textarea from the old pre-recording value.
              voiceBaseRef.current = nextPrompt;
              voiceCommittedTranscriptRef.current = "";
              voiceLiveTranscriptRef.current = "";
              voiceAnchorRef.current = {
                start: event.target.selectionStart,
                end: event.target.selectionEnd,
              };
            }
            setPrompt(nextPrompt);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            // Ctrl/Cmd+Enter always sends; plain Enter follows the setting.
            if (event.ctrlKey || event.metaKey || (enterToSend && !event.shiftKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder="Ask, build, review… use / for skills and @ for context"
          aria-label="Task message"
          autoFocus
        />
        <div className="composer-context-row">
          <button
            className="composer-tool"
            type="button"
            onClick={onAddContext}
            disabled={!onAddContext}
            title={
              onAddContext
                ? "Add task context"
                : "File context will be available when attachments are stored with this task."
            }
          >
            <FilePlus2 />
            <span>Add context</span>
          </button>
          <button
            className="composer-tool"
            type="button"
            onClick={insertMention}
            title="Insert @ to mention a file, symbol, or skill"
          >
            <AtSign />
            <span>Mention</span>
          </button>
          <span className="context-chip">
            <Sparkles /> v1 contract
          </span>
        </div>
        <div className="composer-control-row">
          <div className="composer-controls-left">
            <Dropdown
              className="compact-select"
              aria-label="Permission"
              leading={<ShieldCheck />}
              value={permission}
              onChange={(next) => {
                routingTouched.current = true;
                setPermission(next as typeof permission);
              }}
              options={[
                { value: "read-only", label: "Read only" },
                { value: "project-write", label: "Project write" },
                { value: "ask", label: "Ask as needed" },
                { value: "full-access", label: "Full access" },
              ]}
              compact
            />
            <Dropdown
              className="compact-select"
              aria-label="Delegation"
              leading={<Users />}
              value={delegation}
              onChange={(next) => setDelegation(next as typeof delegation)}
              options={[
                { value: "off", label: "No delegation" },
                { value: "manual", label: "Manual" },
                { value: "balanced", label: "Balanced delegation" },
                { value: "budget-first", label: "Budget first" },
              ]}
              compact
            />
          </div>
          <div className="composer-controls-right">
            {effortOptions.length > 0 ? (
              <Dropdown
                className="compact-select effort-select"
                aria-label="Reasoning effort"
                leading={<Gauge />}
                value={activeEffort}
                onChange={(next) => {
                  routingTouched.current = true;
                  setEffort(next);
                  emitRoutingChange(runtime, activeModel, next);
                }}
                options={effortOptions.map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
                compact
              />
            ) : null}
            <Dropdown
              className="model-select"
              aria-label="Model"
              value={activeModel}
              onChange={(next) => {
                routingTouched.current = true;
                setModel(next);
                // Each model carries its own effort levels; prefer the user's
                // global default when the new model supports it.
                const nextEntry = catalog.find((entry) => entry.id === next);
                const nextEfforts = nextEntry?.efforts ?? [];
                const nextEffort = resolveModelEffort(nextEntry, defaultEffort);
                setEffort(nextEffort);
                emitRoutingChange(runtime, next, nextEfforts.length > 0 ? nextEffort : undefined);
              }}
              options={catalog.map((entry) => ({ value: entry.id, label: entry.label }))}
              compact
            />
            <Dropdown
              className="route-select"
              aria-label="Runtime"
              value={runtime}
              onChange={(next) => {
                routingTouched.current = true;
                const nextRuntime = next as RuntimeId;
                const nextModel =
                  providerCatalogs[nextRuntime]?.[0]?.id ??
                  runtimes.find((item) => item.id === nextRuntime)?.models[0] ??
                  "Provider default";
                const nextEntry = providerCatalogs[nextRuntime]?.find(
                  (entry) => entry.id === nextModel,
                );
                const nextEfforts = nextEntry?.efforts ?? [];
                const nextEffort = resolveModelEffort(nextEntry, defaultEffort);
                setRuntime(nextRuntime);
                setModel(nextModel);
                setEffort(nextEffort);
                emitRoutingChange(
                  nextRuntime,
                  nextModel,
                  nextEfforts.length > 0 ? nextEffort : undefined,
                );
              }}
              options={runtimes.map((item) => ({
                value: item.id,
                label:
                  item.status === "not_installed"
                    ? item.id === "cursor"
                      ? "Cursor (ACP unavailable)"
                      : `${item.name} (not installed)`
                    : item.name,
                icon: <ProviderIcon provider={item.id} label={item.name} />,
                disabled: item.status === "not_installed",
              }))}
              compact
            />
            <button
              className={`icon-button composer-mic${voiceRecording ? " is-recording" : ""}`}
              type="button"
              onClick={() => void (voiceActive ? stopVoiceTyping() : startVoiceTyping())}
              aria-label={voiceActive ? "Stop voice typing" : "Start voice typing"}
              aria-pressed={voiceRecording}
              aria-keyshortcuts={voiceRecording ? "Escape" : undefined}
              disabled={
                voicePhase === "stopping" ||
                voiceConfigured === null ||
                voiceConfigured === false
              }
              title={
                voicePhase === "starting"
                  ? "Cancel voice typing startup"
                  : voicePhase === "stopping"
                    ? "Finishing voice text in the draft"
                    : voiceRecording
                      ? "Stop listening and keep the words in the draft"
                      : voiceConfigured
                        ? "Start realtime voice typing"
                        : voiceConfigured === null
                          ? "Checking voice typing setup"
                          : "Add an OpenAI API key in Settings → General"
              }
            >
              {voiceActive ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </button>
            <Dropdown
              className="mic-select"
              aria-label="Microphone"
              value={
                micDevices.some((device) => device.deviceId === micDeviceId)
                  ? micDeviceId
                  : "default"
              }
              onChange={setMicDeviceId}
              options={[
                { value: "default", label: "Default mic" },
                ...micDevices
                  .filter((device) => device.deviceId && device.deviceId !== "default")
                  .map((device, index) => ({
                    value: device.deviceId,
                    label: device.label || `Microphone ${index + 1}`,
                  })),
              ]}
              compact
            />
            {running && onStop && !prompt.trim() ? (
              <motion.button
                className="send-button send-button--stop"
                type="button"
                onClick={onStop}
                disabled={stopping}
                aria-label={stopping ? "Stopping turn" : "Stop turn"}
                title={stopping ? "Stopping…" : "Stop the current turn"}
                whileTap={{ scale: 0.94 }}
              >
                <Square />
              </motion.button>
            ) : (
              <motion.button
                className="send-button"
                type="button"
                onClick={() => void submit()}
                disabled={!prompt.trim() || sending}
                aria-label={sending ? "Sending" : "Send message"}
                whileTap={{ scale: 0.94 }}
              >
                <ArrowUp />
              </motion.button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-footnote">
        {enterToSend
          ? "Enter to send · Shift Enter for a new line"
          : "Ctrl Enter to send · Enter for a new line"}{" "}
        · agents can make mistakes; review changes
      </p>
      {runtimeWarning || voiceActive || voiceNotice || voiceError ? (
        // Absolutely positioned so transient status lines never change the
        // composer's height or push it up while typing.
        <div className="composer-status-overlay" aria-label="Composer status">
          {runtimeWarning ? (
            <p className="composer-runtime-warning" role="status">
              {runtimeWarning}
            </p>
          ) : null}
          {voiceActive ? (
            <p
              className={`composer-voice-status composer-voice-status--${voicePhase}`}
              role="status"
              aria-live="polite"
            >
              {voicePhase === "starting"
                ? "Starting voice typing…"
                : voicePhase === "stopping"
                  ? "Finishing your words… they will stay in the draft."
                  : "Listening… click the mic again or press Escape when you’re done."}
            </p>
          ) : null}
          {voiceNotice ? (
            <p
              className="composer-voice-status composer-voice-status--saved"
              role="status"
              aria-live="polite"
            >
              {voiceNotice}
            </p>
          ) : null}
          {voiceError ? (
            <p className="composer-voice-status" role="status">
              {voiceError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
