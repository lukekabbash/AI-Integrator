import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m as motion } from "motion/react";
import {
  CalendarClock,
  ExternalLink,
  History,
  Minus,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import {
  bridge,
  resolveModelEffort,
  type Automation,
  type AutomationFallback,
  type AutomationRoute,
  type AutomationRun,
  type AutomationTrigger,
  type ModelCatalogEntry,
  type ProjectSummary,
  type RuntimeConnection,
  type RuntimeId,
  type TaskSummary,
} from "../bridge";
import { prettyModelLabel } from "../modelLabel";
import { Dropdown, ProviderIcon, type DropdownOption } from "./Dropdown";
import { RightRailShell } from "./RightRail";
import { SlidingPanelSlot } from "./SlidingPanelSlot";

type ScheduleFilter = "all" | "active" | "paused" | "needs-attention";
type MainView = { kind: "browser" } | { kind: "run"; id: string };
type RouteCandidate = Pick<AutomationRoute, "runtime" | "model" | "effort">;
type ScheduleDraft = Pick<
  Automation,
  "title" | "prompt" | "trigger" | "route" | "recurrenceUserRequest"
> & { iterationNotes: boolean };

const PERMISSIONS: DropdownOption[] = [
  { value: "read-only", label: "Read only" },
  { value: "project-write", label: "Project write" },
  { value: "ask", label: "Ask as needed" },
  { value: "full-access", label: "Full access" },
];

const DELEGATION: DropdownOption[] = [
  { value: "off", label: "No delegation" },
  { value: "manual", label: "Manual" },
  { value: "balanced", label: "Balanced" },
  { value: "budget-first", label: "Budget first" },
];

function runtimeName(runtime: RuntimeId, runtimes: RuntimeConnection[]): string {
  return runtimes.find((item) => item.id === runtime)?.name ?? runtime;
}

function dateInputValue(date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function statusLabel(status: Automation["status"]): string {
  if (status === "needs-attention") return "Needs attention";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.kind === "at") {
    return `Once · ${new Date(trigger.runAt).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    })}`;
  }
  if (trigger.kind === "delegationsSettled") {
    const count = trigger.delegationIds.length;
    return `When ${trigger.requireAll ? "all" : "any"} ${count} subagent${count === 1 ? "" : "s"} finish`;
  }
  const seconds = trigger.everySeconds;
  if (seconds % 86_400 === 0)
    return `Every ${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `Every ${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `Every ${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
}

function nextRunLabel(automation: Automation): string {
  if (automation.status === "paused") return "Paused";
  if (automation.status === "running") return "Running now";
  if (!automation.nextRunAt) return statusLabel(automation.status);
  return new Date(automation.nextRunAt).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function runLabel(run: AutomationRun): string {
  return new Date(run.scheduledFor).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function intervalParts(seconds: number): { amount: number; unit: "minutes" | "hours" | "days" } {
  if (seconds % 86_400 === 0) return { amount: seconds / 86_400, unit: "days" };
  if (seconds % 3_600 === 0) return { amount: seconds / 3_600, unit: "hours" };
  return { amount: Math.max(1, seconds / 60), unit: "minutes" };
}

function intervalSeconds(amount: number, unit: "minutes" | "hours" | "days"): number {
  return amount * (unit === "days" ? 86_400 : unit === "hours" ? 3_600 : 60);
}

function draftFor(automation: Automation): ScheduleDraft {
  return {
    title: automation.title,
    prompt: automation.prompt,
    trigger: automation.trigger,
    route: { ...automation.route, fallbacks: automation.route.fallbacks ?? [] },
    recurrenceUserRequest: automation.recurrenceUserRequest,
    iterationNotes: automation.iterationNotes ?? false,
  };
}

function sameDraft(left: ScheduleDraft, right: ScheduleDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function RouteRow({
  label,
  route,
  runtimes,
  catalogs,
  onChange,
  onRemove,
}: {
  label: string;
  route: RouteCandidate;
  runtimes: RuntimeConnection[];
  catalogs: Partial<Record<RuntimeId, ModelCatalogEntry[]>>;
  onChange: (route: RouteCandidate) => void;
  onRemove?: () => void;
}) {
  const catalog = catalogs[route.runtime] ?? [];
  const runtime = runtimes.find((item) => item.id === route.runtime);
  const modelOptions: DropdownOption[] = catalog.map((entry) => ({
    value: entry.id,
    label: entry.label || prettyModelLabel(entry.id),
  }));
  if (route.model && !modelOptions.some((item) => item.value === route.model)) {
    modelOptions.push({ value: route.model, label: prettyModelLabel(route.model) });
  }
  if (modelOptions.length === 0)
    modelOptions.push({ value: "Provider default", label: "Provider default" });
  const entry = catalog.find((item) => item.id === route.model);
  const effortOptions = entry?.efforts ?? [];
  const runtimeOptions = runtimes.map((item) => ({
    value: item.id,
    label: item.name,
    icon: <ProviderIcon provider={item.id} label={item.name} />,
    disabled: item.status === "not_installed",
  }));

  return (
    <div className="scheduled-route-row">
      <div className="scheduled-route-label">
        <span>{label}</span>
        {onRemove ? (
          <button type="button" aria-label={`Remove ${label}`} onClick={onRemove}>
            <Minus />
          </button>
        ) : null}
      </div>
      <Dropdown
        compact
        aria-label={`${label} runtime`}
        value={route.runtime}
        options={runtimeOptions}
        onOpen={() => void bridge.listModelCatalog(route.runtime)}
        onChange={(value) => {
          const nextRuntime = value as RuntimeId;
          const nextCatalog = catalogs[nextRuntime] ?? [];
          const nextConnection = runtimes.find((item) => item.id === nextRuntime);
          const model = nextCatalog[0]?.id ?? nextConnection?.models[0] ?? "Provider default";
          onChange({
            runtime: nextRuntime,
            model,
            effort: resolveModelEffort(nextCatalog.find((item) => item.id === model)),
          });
        }}
      />
      <Dropdown
        compact
        aria-label={`${label} model`}
        value={route.model}
        options={modelOptions}
        onOpen={() => void bridge.listModelCatalog(route.runtime)}
        onChange={(model) => {
          const nextEntry = catalog.find((item) => item.id === model);
          onChange({ ...route, model, effort: resolveModelEffort(nextEntry, route.effort) });
        }}
      />
      {effortOptions.length > 0 ? (
        <Dropdown
          compact
          aria-label={`${label} thinking`}
          value={resolveModelEffort(entry, route.effort)}
          options={effortOptions.map((effort) => ({ value: effort.id, label: effort.label }))}
          onChange={(effort) => onChange({ ...route, effort })}
        />
      ) : (
        <span className="scheduled-route-default">Default thinking</span>
      )}
      <span className="sr-only">{runtime?.status ?? "unknown"}</span>
    </div>
  );
}

function RouteEditor({
  route,
  runtimes,
  catalogs,
  onChange,
}: {
  route: AutomationRoute;
  runtimes: RuntimeConnection[];
  catalogs: Partial<Record<RuntimeId, ModelCatalogEntry[]>>;
  onChange: (route: AutomationRoute) => void;
}) {
  const addFallback = () => {
    const nextRuntime =
      runtimes.find(
        (runtime) =>
          runtime.status !== "not_installed" &&
          runtime.id !== route.runtime &&
          !route.fallbacks.some((fallback) => fallback.runtime === runtime.id),
      ) ?? runtimes.find((runtime) => runtime.status !== "not_installed");
    if (!nextRuntime || route.fallbacks.length >= 4) return;
    const catalog = catalogs[nextRuntime.id] ?? [];
    const model = catalog[0]?.id ?? nextRuntime.models[0] ?? "Provider default";
    onChange({
      ...route,
      fallbacks: [
        ...route.fallbacks,
        {
          runtime: nextRuntime.id,
          model,
          effort: resolveModelEffort(catalog.find((entry) => entry.id === model)),
        },
      ],
    });
  };

  return (
    <div className="scheduled-route-stack">
      <RouteRow
        label="Primary"
        route={route}
        runtimes={runtimes}
        catalogs={catalogs}
        onChange={(primary) => onChange({ ...route, ...primary })}
      />
      <AnimatePresence initial={false}>
        {route.fallbacks.map((fallback, index) => (
          <motion.div
            key={`${index}-${fallback.runtime}`}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <RouteRow
              label={`Fallback ${index + 1}`}
              route={fallback}
              runtimes={runtimes}
              catalogs={catalogs}
              onChange={(next) =>
                onChange({
                  ...route,
                  fallbacks: route.fallbacks.map((item, itemIndex) =>
                    itemIndex === index ? (next as AutomationFallback) : item,
                  ),
                })
              }
              onRemove={() =>
                onChange({
                  ...route,
                  fallbacks: route.fallbacks.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {route.fallbacks.length < 4 ? (
        <button className="scheduled-add-fallback" type="button" onClick={addFallback}>
          <Plus /> Add fallback
        </button>
      ) : null}
    </div>
  );
}

export function ScheduledView({
  createRequest = 0,
  railOpen,
  onRailOpenChange,
  rightRailWidth,
  onResizeRail,
  motionScale,
  projects,
  tasks,
  runtimes,
  activeTaskId,
  onOpenTask,
}: {
  createRequest?: number;
  railOpen: boolean;
  onRailOpenChange: (open: boolean) => void;
  rightRailWidth: number;
  onResizeRail: (delta: number) => void;
  motionScale: number;
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  runtimes: RuntimeConnection[];
  activeTaskId?: string;
  onOpenTask: (taskId: string) => void;
}) {
  const availableTasks = useMemo(
    () => tasks.filter((task) => !task.parentId && !task.archived),
    [tasks],
  );
  const defaultTask = availableTasks.find((task) => task.id === activeTaskId) ?? availableTasks[0];
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draftState, setDraftState] = useState<{ id: string; value: ScheduleDraft } | null>(null);
  const [catalogs, setCatalogs] = useState<Partial<Record<RuntimeId, ModelCatalogEntry[]>>>({});
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MainView>({ kind: "browser" });
  const [creating, setCreating] = useState(false);
  const [createTaskId, setCreateTaskId] = useState(defaultTask?.id ?? "");
  const [newTitle, setNewTitle] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newKind, setNewKind] = useState<"once" | "repeat">("once");
  const [newIterationNotes, setNewIterationNotes] = useState(true);
  const [newRunAt, setNewRunAt] = useState(() =>
    dateInputValue(new Date(Date.now() + 60 * 60_000)),
  );
  const [newEvery, setNewEvery] = useState(1);
  const [newUnit, setNewUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selected = automations.find((automation) => automation.id === selectedId);
  const draft = selected
    ? draftState?.id === selected.id
      ? draftState.value
      : draftFor(selected)
    : null;
  const setDraft = (value: ScheduleDraft) => {
    if (selected) setDraftState({ id: selected.id, value });
  };
  const selectedRun = view.kind === "run" ? runs.find((run) => run.id === view.id) : undefined;
  const draftTrigger = draft?.trigger;
  const draftInterval =
    draftTrigger?.kind === "interval" ? intervalParts(draftTrigger.everySeconds) : undefined;

  const refresh = useCallback(async () => {
    const next = await bridge.listAutomations();
    setAutomations(next);
    setSelectedId((current) =>
      next.some((item) => item.id === current) ? current : (next[0]?.id ?? ""),
    );
  }, []);

  useEffect(() => {
    // External store hydration is the synchronization this effect owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Could not load scheduled tasks"),
    );
    let active = true;
    let unlisten: (() => void) | undefined;
    void bridge
      .subscribeAutomationChanges(() => {
        if (active) void refresh();
      })
      .then((dispose) => {
        if (active) unlisten = dispose;
        else dispose();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refresh]);

  useEffect(() => {
    // The titlebar counter is an explicit open request from the parent shell.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (createRequest > 0) setCreating(true);
  }, [createRequest]);

  useEffect(() => {
    // Run history is external state keyed by the selected automation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!selected) setRuns([]);
    else
      void bridge
        .listAutomationRuns(selected.id)
        .then(setRuns)
        .catch(() => setRuns([]));
  }, [selected]);

  const routeRuntimes = draft
    ? [draft.route.runtime, ...draft.route.fallbacks.map((fallback) => fallback.runtime)]
    : [];
  const routeRuntimeKey = routeRuntimes.join(":");
  useEffect(() => {
    for (const runtime of routeRuntimes) {
      if (catalogs[runtime]) continue;
      void bridge
        .listModelCatalog(runtime)
        .then((catalog) => setCatalogs((current) => ({ ...current, [runtime]: catalog })));
    }
    // The joined key changes only when the route stack changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeRuntimeKey]);

  const taskLabel = useCallback(
    (taskId: string) => {
      const task = tasks.find((item) => item.id === taskId);
      const project = projects.find((item) => item.id === task?.projectId);
      return [project?.name, task?.title].filter(Boolean).join(" · ") || "Unavailable chat";
    },
    [projects, tasks],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return automations.filter(
      (automation) =>
        (filter === "all" || automation.status === filter) &&
        (!needle ||
          `${automation.title} ${taskLabel(automation.taskId)}`.toLowerCase().includes(needle)),
    );
  }, [automations, filter, query, taskLabel]);

  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
      if (selectedId) setRuns(await bridge.listAutomationRuns(selectedId));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The scheduled task could not be changed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createSchedule = async () => {
    const effectiveTaskId = createTaskId || defaultTask?.id || "";
    const task = tasks.find((item) => item.id === effectiveTaskId);
    if (!task || !newTitle.trim() || !newPrompt.trim()) return;
    if (!newRunAt) return;
    const seconds = intervalSeconds(newEvery, newUnit);
    const trigger: AutomationTrigger =
      newKind === "once"
        ? { kind: "at", runAt: new Date(newRunAt).toISOString() }
        : { kind: "interval", everySeconds: seconds, anchorAt: new Date(newRunAt).toISOString() };
    await perform(async () => {
      const automation = await bridge.createAutomation({
        taskId: task.id,
        title: newTitle.trim(),
        prompt: newPrompt.trim(),
        target: { kind: "task" },
        trigger,
        route: {
          runtime: task.runtime,
          model: task.model || "Provider default",
          effort: task.effort,
          fallbacks: [],
          permission: "read-only",
          delegation: "off",
        },
        recurrenceUserRequest: newKind === "repeat" ? `Every ${newEvery} ${newUnit}` : undefined,
        iterationNotes: newKind === "repeat" && newIterationNotes,
      });
      setSelectedId(automation.id);
      setCreating(false);
      setNewTitle("");
      setNewPrompt("");
      setNewIterationNotes(true);
      onRailOpenChange(true);
    });
  };

  const saveDraft = () => {
    if (!selected || !draft) return;
    void perform(() => bridge.updateAutomation(selected.id, draft)).then((saved) => {
      if (saved) setDraftState(null);
    });
  };

  const setupPanel =
    selected && draft ? (
      <div className="scheduled-rail-panel scheduled-setup-panel">
        <div className="scheduled-rail-heading">
          <span>
            {statusLabel(selected.status)} · {triggerLabel(draft.trigger)}
          </span>
          <input
            aria-label="Scheduled task title"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <textarea
            aria-label="Scheduled task prompt"
            value={draft.prompt}
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          />
        </div>
        <div className="scheduled-target-row">
          <span>Continues in</span>
          <button type="button" onClick={() => onOpenTask(selected.taskId)}>
            {taskLabel(selected.taskId)} <ExternalLink />
          </button>
        </div>
        {draft.trigger.kind === "at" ? (
          <label className="scheduled-field">
            <span>Wake up</span>
            <input
              type="datetime-local"
              value={dateInputValue(new Date(draft.trigger.runAt))}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  trigger: { kind: "at", runAt: new Date(event.target.value).toISOString() },
                })
              }
            />
          </label>
        ) : null}
        {draftTrigger?.kind === "interval" && draftInterval ? (
          <>
            <div className="scheduled-interval-editor">
              <span>Repeat every</span>
              <input
                aria-label="Repeat interval"
                type="number"
                min="1"
                value={draftInterval.amount}
                onChange={(event) => {
                  const amount = Math.max(1, Number(event.target.value));
                  setDraft({
                    ...draft,
                    recurrenceUserRequest: `Every ${amount} ${draftInterval.unit}`,
                    trigger: {
                      ...draftTrigger,
                      everySeconds: intervalSeconds(amount, draftInterval.unit),
                    },
                  });
                }}
              />
              <select
                aria-label="Repeat interval unit"
                value={draftInterval.unit}
                onChange={(event) => {
                  const unit = event.target.value as typeof draftInterval.unit;
                  setDraft({
                    ...draft,
                    recurrenceUserRequest: `Every ${draftInterval.amount} ${unit}`,
                    trigger: {
                      ...draftTrigger,
                      everySeconds: intervalSeconds(draftInterval.amount, unit),
                    },
                  });
                }}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <input
                aria-label="Next run"
                type="datetime-local"
                value={dateInputValue(new Date(draftTrigger.anchorAt))}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    trigger: {
                      ...draftTrigger,
                      anchorAt: new Date(event.target.value).toISOString(),
                    },
                  })
                }
              />
            </div>
            <div className="scheduled-iteration-row">
              <span>
                <strong>Build on previous runs</strong>
                <small>Carry one concise agent-written note into the next prompt.</small>
              </span>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-label="Build on previous runs"
                aria-checked={draft.iterationNotes}
                data-checked={draft.iterationNotes}
                onClick={() => setDraft({ ...draft, iterationNotes: !draft.iterationNotes })}
              >
                <span />
              </button>
            </div>
            {draft.iterationNotes && selected.nextRunNote ? (
              <div className="scheduled-next-note">
                <span>Next run note</span>
                <p>{selected.nextRunNote}</p>
              </div>
            ) : null}
          </>
        ) : null}
        <RouteEditor
          route={draft.route}
          runtimes={runtimes}
          catalogs={catalogs}
          onChange={(route) => setDraft({ ...draft, route })}
        />
        <div className="scheduled-policy-row">
          <Dropdown
            compact
            aria-label="Permission ceiling"
            value={draft.route.permission}
            options={PERMISSIONS}
            onChange={(permission) =>
              setDraft({
                ...draft,
                route: { ...draft.route, permission: permission as AutomationRoute["permission"] },
              })
            }
          />
          <Dropdown
            compact
            aria-label="Delegation"
            value={draft.route.delegation}
            options={DELEGATION}
            onChange={(delegation) =>
              setDraft({
                ...draft,
                route: { ...draft.route, delegation: delegation as AutomationRoute["delegation"] },
              })
            }
          />
        </div>
        {error ? <p className="scheduled-error">{error}</p> : null}
        <div className="scheduled-rail-actions">
          <button
            type="button"
            disabled={busy || selected.status === "running"}
            onClick={() =>
              void perform(() =>
                bridge.setAutomationPaused(selected.id, selected.status !== "paused"),
              )
            }
          >
            {selected.status === "paused" ? <Play /> : <Pause />}
            {selected.status === "paused" ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void perform(() => bridge.runAutomationNow(selected.id))}
          >
            <Play /> Run now
          </button>
          <button
            className="scheduled-save"
            type="button"
            disabled={busy || sameDraft(draft, draftFor(selected))}
            onClick={saveDraft}
          >
            Save
          </button>
        </div>
      </div>
    ) : (
      <div className="scheduled-rail-empty">Select a scheduled task</div>
    );

  const runsPanel = selected ? (
    <div className="scheduled-rail-panel scheduled-runs-panel">
      <div className="scheduled-rail-heading">
        <span>
          {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
        <strong>{selected.title}</strong>
      </div>
      <div className="scheduled-run-list">
        {runs.length ? (
          runs.map((run) => (
            <button
              type="button"
              key={run.id}
              data-active={view.kind === "run" && view.id === run.id}
              onClick={() => setView({ kind: "run", id: run.id })}
            >
              <span>{runLabel(run)}</span>
              <strong>{statusLabel(run.status as Automation["status"])}</strong>
              <small>
                {run.finishedAt
                  ? new Date(run.finishedAt).toLocaleTimeString([], { timeStyle: "short" })
                  : "In progress"}
              </small>
            </button>
          ))
        ) : (
          <p className="scheduled-muted">No runs yet.</p>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div
      className="scheduled-workspace"
      data-rail-open={railOpen}
      style={{ "--right-rail-width": `${rightRailWidth}px` } as CSSProperties}
    >
      <section className="scheduled-canvas">
        {selected && selectedRun ? (
          <motion.div
            className="scheduled-run-view"
            key={selectedRun.id}
            initial={motionScale === 0 ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <button
              className="scheduled-back-button"
              type="button"
              onClick={() => setView({ kind: "browser" })}
            >
              Back to scheduled tasks
            </button>
            <span className="scheduled-eyebrow">Run · {runLabel(selectedRun)}</span>
            <h2>{selected.title}</h2>
            <p className="scheduled-summary">
              {statusLabel(selectedRun.status as Automation["status"])} ·{" "}
              {runtimeName(selected.route.runtime, runtimes)} ·{" "}
              {prettyModelLabel(selected.route.model)}
            </p>
            <section className="scheduled-run-copy">
              <span>Scheduled prompt</span>
              <p>{selected.prompt}</p>
            </section>
            {selectedRun.error ? (
              <section className="scheduled-run-error">
                <span>Could not start</span>
                <p>{selectedRun.error}</p>
              </section>
            ) : null}
            <button
              className="scheduled-open-chat"
              type="button"
              onClick={() => onOpenTask(selected.taskId)}
            >
              Open chat <ExternalLink />
            </button>
          </motion.div>
        ) : (
          <div className="scheduled-browser">
            <div className="scheduled-browser-tools">
              <label>
                <Search aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search scheduled tasks"
                  aria-label="Search scheduled tasks"
                />
              </label>
              <div className="scheduled-filter" aria-label="Filter scheduled tasks">
                {(["all", "active", "paused", "needs-attention"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    data-active={filter === option}
                    onClick={() => setFilter(option)}
                  >
                    {option === "all" ? "All" : statusLabel(option)}
                  </button>
                ))}
              </div>
            </div>
            {error && !selected ? <p className="scheduled-error">{error}</p> : null}
            <div className="scheduled-browser-list" aria-label="Scheduled tasks">
              {filtered.map((automation) => (
                <button
                  key={automation.id}
                  className="scheduled-browser-row"
                  type="button"
                  data-selected={railOpen && automation.id === selected?.id}
                  data-status={
                    automation.status === "needs-attention" ? "attention" : automation.status
                  }
                  onClick={() => {
                    setSelectedId(automation.id);
                    setView({ kind: "browser" });
                    onRailOpenChange(true);
                  }}
                >
                  <span className="scheduled-list-state" aria-hidden="true" />
                  <span className="scheduled-list-copy">
                    <strong>{automation.title}</strong>
                    <small>{taskLabel(automation.taskId)}</small>
                  </span>
                  <span className="scheduled-browser-route">
                    <strong>
                      {runtimeName(automation.route.runtime, runtimes)}
                      {automation.route.fallbacks?.length
                        ? ` +${automation.route.fallbacks.length}`
                        : ""}
                    </strong>
                    <small>{prettyModelLabel(automation.route.model)}</small>
                  </span>
                  <span className="scheduled-browser-time">
                    <strong>{nextRunLabel(automation)}</strong>
                    <small>{triggerLabel(automation.trigger)}</small>
                  </span>
                </button>
              ))}
              {!filtered.length ? (
                <div className="scheduled-empty">
                  <CalendarClock />
                  <strong>No scheduled tasks</strong>
                  <span>Create one here or ask the agent to wake up later.</span>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <SlidingPanelSlot open={railOpen} motionScale={motionScale} slotKey="scheduled-tools">
        <RightRailShell
          tabs={[
            { id: "scheduled-setup", label: "Setup", icon: Settings2, panel: setupPanel },
            {
              id: "scheduled-runs",
              label: "Runs",
              icon: History,
              count: runs.length,
              panel: runsPanel,
            },
          ]}
          initialTab="scheduled-setup"
          label="Scheduled task"
          onResize={onResizeRail}
        />
      </SlidingPanelSlot>

      {createPortal(
        <AnimatePresence>
          {creating ? (
            <motion.div
              className="scheduled-modal-backdrop"
              initial={motionScale === 0 ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onMouseDown={(event) => {
                if (event.currentTarget === event.target) setCreating(false);
              }}
            >
              <motion.form
                className="scheduled-create-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="scheduled-create-title"
                initial={motionScale === 0 ? false : { opacity: 0, y: 10, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.99 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void createSchedule();
                }}
              >
                <header>
                  <div>
                    <CalendarClock aria-hidden="true" />
                    <h2 id="scheduled-create-title">New scheduled task</h2>
                  </div>
                  <button type="button" onClick={() => setCreating(false)} aria-label="Close">
                    <X />
                  </button>
                </header>
                <label>
                  <span>Name</span>
                  <input
                    autoFocus
                    value={newTitle}
                    onChange={(event) => setNewTitle(event.target.value)}
                    placeholder="Check CI again"
                  />
                </label>
                <label>
                  <span>What should the agent do?</span>
                  <textarea
                    value={newPrompt}
                    onChange={(event) => setNewPrompt(event.target.value)}
                    placeholder="Review the latest checks and summarize anything that changed."
                  />
                </label>
                <label>
                  <span>Continue in</span>
                  <select
                    value={createTaskId || defaultTask?.id || ""}
                    onChange={(event) => setCreateTaskId(event.target.value)}
                  >
                    {availableTasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {taskLabel(task.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="scheduled-create-timing">
                  <div className="scheduled-filter">
                    <button
                      type="button"
                      data-active={newKind === "once"}
                      onClick={() => setNewKind("once")}
                    >
                      Once
                    </button>
                    <button
                      type="button"
                      data-active={newKind === "repeat"}
                      onClick={() => setNewKind("repeat")}
                    >
                      Repeat
                    </button>
                  </div>
                  {newKind === "repeat" ? (
                    <>
                      <div className="scheduled-interval-input">
                        <span>Every</span>
                        <input
                          type="number"
                          min="1"
                          value={newEvery}
                          onChange={(event) => setNewEvery(Math.max(1, Number(event.target.value)))}
                        />
                        <select
                          value={newUnit}
                          onChange={(event) => setNewUnit(event.target.value as typeof newUnit)}
                        >
                          <option value="minutes">minutes</option>
                          <option value="hours">hours</option>
                          <option value="days">days</option>
                        </select>
                      </div>
                      <div className="scheduled-create-iteration">
                        <span>
                          <strong>Build on previous runs</strong>
                          <small>The agent can leave a note for its next iteration.</small>
                        </span>
                        <button
                          className="switch"
                          type="button"
                          role="switch"
                          aria-label="Build on previous runs"
                          aria-checked={newIterationNotes}
                          data-checked={newIterationNotes}
                          onClick={() => setNewIterationNotes((enabled) => !enabled)}
                        >
                          <span />
                        </button>
                      </div>
                    </>
                  ) : null}
                  <input
                    type="datetime-local"
                    value={newRunAt}
                    onChange={(event) => setNewRunAt(event.target.value)}
                  />
                </div>
                {error ? <p className="scheduled-error">{error}</p> : null}
                <footer>
                  <button type="button" onClick={() => setCreating(false)}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      busy ||
                      !(createTaskId || defaultTask?.id) ||
                      !newTitle.trim() ||
                      !newPrompt.trim() ||
                      !newRunAt
                    }
                  >
                    Create
                  </button>
                </footer>
              </motion.form>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
