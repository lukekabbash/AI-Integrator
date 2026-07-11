import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowUp,
  AtSign,
  ChevronDown,
  FilePlus2,
  Mic,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { bridge, type RuntimeConnection, type RuntimeId } from "../bridge";

interface ComposerProps {
  runtimes: RuntimeConnection[];
  defaultRuntime: RuntimeId;
  defaultModel: string;
  onSend: (value: {
    prompt: string;
    runtime: RuntimeId;
    model: string;
    permission: "read-only" | "project-write" | "ask" | "full-access";
    delegation: "off" | "manual" | "balanced" | "budget-first";
  }) => Promise<void>;
}

export function Composer({ runtimes, defaultRuntime, defaultModel, onSend }: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [runtime, setRuntime] = useState<RuntimeId>(defaultRuntime);
  const [model, setModel] = useState(defaultModel);
  const [permission, setPermission] = useState<
    "read-only" | "project-write" | "ask" | "full-access"
  >("project-write");
  const [delegation, setDelegation] = useState<"off" | "manual" | "balanced" | "budget-first">(
    "balanced",
  );
  const [sending, setSending] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedRuntime = runtimes.find((item) => item.id === runtime) ?? runtimes[0];
  const modelOptions = providerModels[runtime] ??
    (selectedRuntime?.models.length ? selectedRuntime.models : undefined) ?? ["Provider default"];
  const activeModel = modelOptions.includes(model)
    ? model
    : (modelOptions[0] ?? "Provider default");

  useEffect(() => {
    if (providerModels[runtime]) return;
    let active = true;
    void bridge
      .listModels?.(runtime)
      .then((models) => {
        if (!active || !models?.length) return;
        setProviderModels((current) => ({ ...current, [runtime]: models }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [runtime, providerModels]);

  const submit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend({ prompt: trimmed, runtime, model: activeModel, permission, delegation });
      setPrompt("");
      textareaRef.current?.focus();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer" data-busy={sending}>
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder="Ask, build, review… use / for skills and @ for context"
          aria-label="Task message"
        />
        <div className="composer-context-row">
          <button className="composer-tool" type="button">
            <FilePlus2 />
            <span>Add context</span>
          </button>
          <button className="composer-tool" type="button">
            <AtSign />
            <span>Mention</span>
          </button>
          <span className="context-chip">
            <Sparkles /> v1 contract
          </span>
        </div>
        <div className="composer-control-row">
          <div className="composer-controls-left">
            <label className="compact-select">
              <ShieldCheck />
              <span className="sr-only">Permission</span>
              <select
                value={permission}
                onChange={(event) => setPermission(event.target.value as typeof permission)}
              >
                <option value="read-only">Read only</option>
                <option value="project-write">Project write</option>
                <option value="ask">Ask as needed</option>
                <option value="full-access">Full access</option>
              </select>
              <ChevronDown />
            </label>
            <label className="compact-select">
              <Users />
              <span className="sr-only">Delegation</span>
              <select
                value={delegation}
                onChange={(event) => setDelegation(event.target.value as typeof delegation)}
              >
                <option value="off">No delegation</option>
                <option value="manual">Manual</option>
                <option value="balanced">Balanced delegation</option>
                <option value="budget-first">Budget first</option>
              </select>
              <ChevronDown />
            </label>
          </div>
          <div className="composer-controls-right">
            <label className="model-select">
              <span className="sr-only">Model</span>
              <select value={activeModel} onChange={(event) => setModel(event.target.value)}>
                {modelOptions.map((item) => (
                  <option value={item} key={item}>
                    {item}
                  </option>
                ))}
              </select>
              <ChevronDown />
            </label>
            <label className="route-select">
              <span className={`provider-dot provider-dot--${runtime}`} aria-hidden="true" />
              <span className="sr-only">Runtime</span>
              <select
                value={runtime}
                onChange={(event) => {
                  const nextRuntime = event.target.value as RuntimeId;
                  setRuntime(nextRuntime);
                  setModel(
                    providerModels[nextRuntime]?.[0] ??
                      runtimes.find((item) => item.id === nextRuntime)?.models[0] ??
                      "Provider default",
                  );
                }}
              >
                {runtimes
                  .filter((item) => item.status !== "not_installed")
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
              <ChevronDown />
            </label>
            <button className="icon-button composer-mic" type="button" aria-label="Dictate">
              <Mic />
            </button>
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
          </div>
        </div>
      </div>
      <p className="composer-footnote">
        Enter to send · Shift Enter for a new line · agents can make mistakes; review changes
      </p>
    </div>
  );
}
