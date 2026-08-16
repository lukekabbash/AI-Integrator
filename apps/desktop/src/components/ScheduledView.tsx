import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, LayoutGroup, m as motion } from "motion/react";
import {
  ArrowLeft,
  CalendarClock,
  ExternalLink,
  History,
  MessageSquarePlus,
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
  type AutomationToolScope,
  type IntegratorMcpServer,
  type IntegratorSkillInfo,
  type RuntimeProjectionEvent,
  type TaskSummary,
  type TranscriptEvent,
} from "../bridge";
import { eventsForRun } from "../automationTranscript";
import {
  applyRuntimeProjectionBatch,
  createRuntimeProjectionState,
  hydrateRuntimeProjectionState,
  isFrameBatchableRuntimeProjection,
  runtimeTranscript,
  type RuntimeProjectionState,
} from "../runtimeProjection";
import { prettyModelLabel } from "../modelLabel";
import { Dropdown, ProviderIcon, type DropdownOption } from "./Dropdown";
import { RightRailShell } from "./RightRail";
import { SlidingPanelSlot } from "./SlidingPanelSlot";
import { ToolScopePicker } from "./ToolScopePicker";

const Transcript = lazy(() =>
  import("./Transcript").then((module) => ({ default: module.Transcript })),
);

/* Read-only view of a chat's projection so a run can show the messages it
   produced. Mirrors the subagent conversation loader: hydrate once, then
   fold live projection events (batched per frame) on top. */
function useTaskTranscript(taskId: string | undefined): {
  events: TranscriptEvent[];
  loading: boolean;
  running: boolean;
  error: string;
} {
  const [state, setState] = useState<RuntimeProjectionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const stateRef = useRef<RuntimeProjectionState | null>(null);

  useEffect(() => {
    stateRef.current = null;
    // Task switch resets the read-only projection this effect owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(null);
    setError("");
    if (!taskId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let disposed = false;
    let ready = false;
    let unlisten: (() => void) | undefined;
    let frame: number | undefined;
    const buffered: RuntimeProjectionEvent[] = [];
    const frameEvents: RuntimeProjectionEvent[] = [];
    const apply = (events: RuntimeProjectionEvent[]) => {
      if (!events.length) return;
      const next = applyRuntimeProjectionBatch(
        stateRef.current ?? createRuntimeProjectionState(taskId),
        events,
      );
      stateRef.current = next;
      setState(next);
    };
    const flush = () => {
      frame = undefined;
      apply(frameEvents.splice(0));
    };
    void (async () => {
      try {
        unlisten = await bridge.subscribeRuntimeProjections((event) => {
          if (event.taskId !== taskId) return;
          if (!ready) {
            buffered.push(event);
            return;
          }
          if (isFrameBatchableRuntimeProjection(event)) {
            frameEvents.push(event);
            frame ??= window.requestAnimationFrame(flush);
            return;
          }
          if (frame !== undefined) {
            window.cancelAnimationFrame(frame);
            frame = undefined;
          }
          apply([...frameEvents.splice(0), event]);
        });
        if (disposed) {
          unlisten();
          return;
        }
        const snapshot = await bridge.loadTaskProjection(taskId, { skipRuntimeCheck: true });
        let next = hydrateRuntimeProjectionState(
          taskId,
          snapshot.hydrate ?? {
            items: [],
            plan: [],
            planTruncated: false,
            approvals: [],
            firstSeen: {},
            hasMoreOlder: false,
          },
          snapshot.watermarkSeq,
          snapshot.resetSeq,
        );
        next = applyRuntimeProjectionBatch(
          next,
          buffered
            .filter((candidate) => candidate.seq > snapshot.watermarkSeq)
            .sort((left, right) => left.seq - right.seq),
        );
        if (!disposed) {
          ready = true;
          stateRef.current = next;
          setState(next);
        }
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not load this chat");
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      unlisten?.();
    };
  }, [taskId]);

  const events = useMemo(() => (state ? runtimeTranscript(state) : []), [state]);
  return { events, loading, running: state?.turn?.status === "inProgress", error };
}
import { TravelingSelection } from "./TravelingSelection";

type ScheduleFilter = "all" | "active" | "paused" | "needs-attention";
type MainView = { kind: "browser" } | { kind: "run"; id: string };
type RouteCandidate = Pick<AutomationRoute, "runtime" | "model" | "effort">;
type IntervalUnit = "minutes" | "hours" | "days";
type ScheduleDraft = Pick<
  Automation,
  "title" | "prompt" | "trigger" | "route" | "recurrenceUserRequest"
> & { iterationNotes: boolean };

const FILTERS: ScheduleFilter[] = ["all", "active", "paused", "needs-attention"];

/* "Continue in" targets: an existing chat, a fresh general chat, or a fresh
   chat inside a project. Encoded as dropdown values. */
const NEW_CHAT_TARGET = "new:chat";
const NEW_PROJECT_TARGET_PREFIX = "new:project:";

const UNITS: DropdownOption[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

/* The same settle every other surface uses (menus, tooltips, rail pills). */
const settleSpring = { type: "spring" as const, stiffness: 540, damping: 38, mass: 0.7 };
const rowSpring = { type: "spring" as const, stiffness: 460, damping: 40, mass: 0.7 };

function motionOff(motionScale: number): boolean {
  return (
    motionScale === 0 ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none")
  );
}

/* Blocks present on first render appear in place; only later toggles unfold. */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Flipping once after mount is the point of this hook.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  return mounted;
}

/* Height-reveal used for every conditional block in the rail and the create
   sheet, so sections unfold instead of popping. Overflow is only clipped
   while the height is in flight — dropdown menus inside must escape once
   the block has settled. */
function UnfoldingBlock({
  motionScale,
  animateIn,
  className,
  children,
}: {
  motionScale: number;
  animateIn: boolean;
  className?: string;
  children: ReactNode;
}) {
  const off = motionOff(motionScale);
  const [settled, setSettled] = useState(off || !animateIn);
  return (
    <motion.div
      className={className}
      style={{ overflow: settled ? "visible" : "hidden" }}
      initial={off || !animateIn ? false : { height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={
        off
          ? { duration: 0 }
          : { height: settleSpring, opacity: { duration: 0.16, ease: [0.2, 0, 0, 1] } }
      }
      onAnimationStart={() => setSettled(false)}
      onAnimationComplete={(definition) => {
        if (typeof definition === "object" && definition && "height" in definition) {
          setSettled((definition as { height?: unknown }).height === "auto");
        }
      }}
    >
      {children}
    </motion.div>
  );
}

function Reveal({
  show,
  motionScale,
  className,
  children,
}: {
  show: boolean;
  motionScale: number;
  className?: string;
  children: ReactNode;
}) {
  const mounted = useMounted();
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <UnfoldingBlock motionScale={motionScale} animateIn={mounted} className={className}>
          {children}
        </UnfoldingBlock>
      ) : null}
    </AnimatePresence>
  );
}

/* Segmented filter with the traveling pill — same language as the sidebar
   and settings nav rather than a static highlighted button. */
function FilterPills<T extends string>({
  value,
  options,
  onChange,
  label,
  layoutKey,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  layoutKey: string;
}) {
  return (
    <div className="scheduled-filter" role="group" aria-label={label}>
      <TravelingSelection
        activeKey={value}
        className="scheduled-filter-active"
        layoutKey={`${layoutKey}:${options.map((option) => option.value).join("|")}`}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-active={value === option.value}
          data-traveling-selection={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

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

function intervalParts(seconds: number): { amount: number; unit: IntervalUnit } {
  if (seconds % 86_400 === 0) return { amount: seconds / 86_400, unit: "days" };
  if (seconds % 3_600 === 0) return { amount: seconds / 3_600, unit: "hours" };
  return { amount: Math.max(1, seconds / 60), unit: "minutes" };
}

function intervalSeconds(amount: number, unit: IntervalUnit): number {
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
  motionScale,
  onChange,
}: {
  route: AutomationRoute;
  runtimes: RuntimeConnection[];
  catalogs: Partial<Record<RuntimeId, ModelCatalogEntry[]>>;
  motionScale: number;
  onChange: (route: AutomationRoute) => void;
}) {
  const mounted = useMounted();
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
          <UnfoldingBlock
            key={`${index}-${fallback.runtime}`}
            motionScale={motionScale}
            animateIn={mounted}
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
          </UnfoldingBlock>
        ))}
      </AnimatePresence>
      <Reveal show={route.fallbacks.length < 4} motionScale={motionScale}>
        <button className="scheduled-add-fallback" type="button" onClick={addFallback}>
          <Plus /> Add fallback
        </button>
      </Reveal>
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
  defaultRoute,
  onOpenTask,
  onTaskCreated,
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
  /** Runtime/model the shell would use for a brand-new chat. */
  defaultRoute?: RouteCandidate;
  onOpenTask: (taskId: string) => void;
  /** A chat created for a schedule; the shell adds it to the workspace snapshot. */
  onTaskCreated?: (task: TaskSummary) => void;
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
  const [toolInventory, setToolInventory] = useState<{
    mcps: IntegratorMcpServer[];
    skills: IntegratorSkillInfo[];
    loaded: boolean;
  }>({ mcps: [], skills: [], loaded: false });
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MainView>({ kind: "browser" });
  const [creating, setCreating] = useState(false);
  const [createTarget, setCreateTarget] = useState(defaultTask?.id ?? NEW_CHAT_TARGET);
  const [createRouteOverride, setCreateRouteOverride] = useState<RouteCandidate | null>(null);
  const [createPermission, setCreatePermission] =
    useState<AutomationRoute["permission"]>("read-only");
  const [createDelegation, setCreateDelegation] = useState<AutomationRoute["delegation"]>("off");
  const [createTools, setCreateTools] = useState<AutomationToolScope | undefined>(undefined);
  const [newTitle, setNewTitle] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newKind, setNewKind] = useState<"once" | "repeat">("once");
  const [newIterationNotes, setNewIterationNotes] = useState(true);
  const [newRunAt, setNewRunAt] = useState(() =>
    dateInputValue(new Date(Date.now() + 60 * 60_000)),
  );
  const [newEvery, setNewEvery] = useState(1);
  const [newUnit, setNewUnit] = useState<IntervalUnit>("hours");
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
  const runTranscript = useTaskTranscript(selectedRun ? selected?.taskId : undefined);
  const runEvents = useMemo(
    () =>
      selected && selectedRun ? eventsForRun(runTranscript.events, selected, selectedRun) : [],
    [runTranscript.events, selected, selectedRun],
  );
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

  // The titlebar counter is an explicit open request from the parent shell.
  // Remounting with a stale counter (navigating back to Scheduled) must not
  // reopen the sheet, so only a change since mount counts.
  const handledCreateRequest = useRef(createRequest);
  useEffect(() => {
    if (createRequest === handledCreateRequest.current) return;
    handledCreateRequest.current = createRequest;
    setCreating(true);
  }, [createRequest]);

  useEffect(() => {
    if (!creating) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An open menu inside the sheet owns Escape; the sheet closes on the next one.
      if (document.querySelector('.scheduled-create-sheet [data-open="true"]')) return;
      setCreating(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [creating]);

  const needsToolInventory = creating || Boolean(selected);
  useEffect(() => {
    if (!needsToolInventory || toolInventory.loaded) return;
    let active = true;
    void Promise.all([bridge.listIntegratorMcps(), bridge.listIntegratorSkills()])
      .then(([mcpOverview, skillOverview]) => {
        if (active)
          setToolInventory({
            mcps: mcpOverview.servers,
            skills: skillOverview.skills,
            loaded: true,
          });
      })
      .catch(() => {
        if (active) setToolInventory((current) => ({ ...current, loaded: true }));
      });
    return () => {
      active = false;
    };
  }, [needsToolInventory, toolInventory.loaded]);

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

  const createTargetTask = tasks.find((task) => task.id === createTarget);
  const createProjectId = createTarget.startsWith(NEW_PROJECT_TARGET_PREFIX)
    ? createTarget.slice(NEW_PROJECT_TARGET_PREFIX.length)
    : undefined;
  const createTargetIsNew = createTarget === NEW_CHAT_TARGET || Boolean(createProjectId);
  const fallbackRoute: RouteCandidate = defaultRoute ?? {
    runtime:
      runtimes.find((runtime) => runtime.status !== "not_installed")?.id ??
      runtimes[0]?.id ??
      "codex",
    model: "Provider default",
  };
  const createRoute: RouteCandidate =
    createRouteOverride ??
    (createTargetTask
      ? {
          runtime: createTargetTask.runtime,
          model: createTargetTask.model || "Provider default",
          effort: createTargetTask.effort,
        }
      : fallbackRoute);

  const routeRuntimes = [
    ...(draft
      ? [draft.route.runtime, ...draft.route.fallbacks.map((fallback) => fallback.runtime)]
      : []),
    ...(creating ? [createRoute.runtime] : []),
  ];
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
    if (!createTargetIsNew && !createTargetTask) return;
    if (!newTitle.trim() || !newPrompt.trim() || !newRunAt) return;
    const seconds = intervalSeconds(newEvery, newUnit);
    const trigger: AutomationTrigger =
      newKind === "once"
        ? { kind: "at", runAt: new Date(newRunAt).toISOString() }
        : { kind: "interval", everySeconds: seconds, anchorAt: new Date(newRunAt).toISOString() };
    await perform(async () => {
      let taskId = createTargetTask?.id;
      if (!taskId) {
        // A schedule that continues in a new chat owns that chat: name it after
        // the schedule so the sidebar and the run history read the same.
        const created = await bridge.createChat({
          runtime: createRoute.runtime,
          model: createRoute.model,
          ...(createRoute.effort ? { effort: createRoute.effort } : {}),
          ...(createProjectId ? { projectId: createProjectId } : {}),
          title: newTitle.trim(),
        });
        onTaskCreated?.(created);
        taskId = created.id;
      }
      const automation = await bridge.createAutomation({
        taskId,
        title: newTitle.trim(),
        prompt: newPrompt.trim(),
        target: { kind: "task" },
        trigger,
        route: {
          runtime: createRoute.runtime,
          model: createRoute.model || "Provider default",
          effort: createRoute.effort,
          fallbacks: [],
          permission: createPermission,
          delegation: createDelegation,
          ...(createTools ? { tools: createTools } : {}),
        },
        recurrenceUserRequest: newKind === "repeat" ? `Every ${newEvery} ${newUnit}` : undefined,
        iterationNotes: newKind === "repeat" && newIterationNotes,
      });
      setSelectedId(automation.id);
      setCreating(false);
      setNewTitle("");
      setNewPrompt("");
      setNewIterationNotes(true);
      setCreateRouteOverride(null);
      setCreateTools(undefined);
      if (createTargetIsNew) setCreateTarget(taskId);
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
            <i className="scheduled-status-dot" data-status={selected.status} aria-hidden="true" />
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
              <Dropdown
                compact
                aria-label="Repeat interval unit"
                value={draftInterval.unit}
                options={UNITS}
                onChange={(value) => {
                  const unit = value as IntervalUnit;
                  setDraft({
                    ...draft,
                    recurrenceUserRequest: `Every ${draftInterval.amount} ${unit}`,
                    trigger: {
                      ...draftTrigger,
                      everySeconds: intervalSeconds(draftInterval.amount, unit),
                    },
                  });
                }}
              />
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
            <Reveal
              show={Boolean(draft.iterationNotes && selected.nextRunNote)}
              motionScale={motionScale}
            >
              <div className="scheduled-next-note">
                <span>Next run note</span>
                <p>{selected.nextRunNote}</p>
              </div>
            </Reveal>
          </>
        ) : null}
        <RouteEditor
          route={draft.route}
          runtimes={runtimes}
          catalogs={catalogs}
          motionScale={motionScale}
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
        <div className="scheduled-tools-row">
          <span>Tools</span>
          <ToolScopePicker
            aria-label="Tools"
            value={draft.route.tools}
            mcps={toolInventory.mcps}
            skills={toolInventory.skills}
            loading={!toolInventory.loaded}
            onChange={(tools) => {
              const rest = { ...draft.route };
              delete rest.tools;
              setDraft({ ...draft, route: tools ? { ...rest, tools } : rest });
            }}
          />
        </div>
        <Reveal show={Boolean(error)} motionScale={motionScale}>
          <p className="scheduled-error">{error}</p>
        </Reveal>
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
      <div className="scheduled-rail-empty">
        <CalendarClock aria-hidden="true" />
        <span>Select a scheduled task</span>
      </div>
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
        <TravelingSelection
          activeKey={view.kind === "run" ? view.id : ""}
          className="scheduled-run-active"
          layoutKey={runs.map((run) => run.id).join("|")}
        />
        {runs.length ? (
          runs.map((run) => (
            <button
              type="button"
              key={run.id}
              data-active={view.kind === "run" && view.id === run.id}
              data-traveling-selection={run.id}
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

  const off = motionOff(motionScale);
  const viewTransition = off
    ? { duration: 0 }
    : { duration: 0.2 * motionScale, ease: [0.2, 0, 0, 1] as const };
  const targetOptions: DropdownOption[] = [
    { value: NEW_CHAT_TARGET, label: "New chat", icon: <MessageSquarePlus aria-hidden="true" /> },
    ...projects.map((project) => ({
      value: `${NEW_PROJECT_TARGET_PREFIX}${project.id}`,
      label: `New chat in ${project.name}`,
      icon: <MessageSquarePlus aria-hidden="true" />,
    })),
    ...availableTasks.map((task) => ({
      value: task.id,
      label: taskLabel(task.id),
      icon: <ProviderIcon provider={task.runtime} label={task.runtime} />,
    })),
  ];
  const kindOptions = [
    { value: "once" as const, label: "Once" },
    { value: "repeat" as const, label: "Repeat" },
  ];

  return (
    <div
      className="scheduled-workspace"
      data-rail-open={railOpen}
      style={{ "--right-rail-width": `${rightRailWidth}px` } as CSSProperties}
    >
      <section className="scheduled-canvas">
        <AnimatePresence initial={false} mode="popLayout">
          {selected && selectedRun ? (
            <motion.div
              className="scheduled-run-view"
              key={`run:${selectedRun.id}`}
              initial={off ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={viewTransition}
            >
              <button
                className="scheduled-back-button"
                type="button"
                onClick={() => setView({ kind: "browser" })}
              >
                <ArrowLeft aria-hidden="true" /> Back to scheduled tasks
              </button>
              <div className="scheduled-run-header">
                <div>
                  <span className="scheduled-eyebrow">Run · {runLabel(selectedRun)}</span>
                  <h2>{selected.title}</h2>
                  <p className="scheduled-summary">
                    {statusLabel(selectedRun.status as Automation["status"])} ·{" "}
                    {runtimeName(selected.route.runtime, runtimes)} ·{" "}
                    {prettyModelLabel(selected.route.model)} · {taskLabel(selected.taskId)}
                  </p>
                </div>
                <button
                  className="scheduled-open-chat"
                  type="button"
                  onClick={() => onOpenTask(selected.taskId)}
                >
                  Open chat <ExternalLink />
                </button>
              </div>
              {selectedRun.error ? (
                <section className="scheduled-run-error">
                  <span>Could not start</span>
                  <p>{selectedRun.error}</p>
                </section>
              ) : null}
              <section className="scheduled-run-transcript" aria-label="Run messages">
                {runEvents.length ? (
                  <Suspense fallback={<p className="scheduled-muted">Rendering messages…</p>}>
                    <Transcript
                      ownerKey={`scheduled-run:${selectedRun.id}`}
                      events={runEvents}
                      running={runTranscript.running}
                      virtualizationEnabled={false}
                      modelForEvent={() => prettyModelLabel(selected.route.model)}
                    />
                  </Suspense>
                ) : runTranscript.loading ? (
                  <p className="scheduled-muted">Loading messages…</p>
                ) : runTranscript.error ? (
                  <p className="scheduled-error">{runTranscript.error}</p>
                ) : (
                  <div className="scheduled-run-pending">
                    <span>
                      {selectedRun.status === "failed"
                        ? "This run never reached the chat."
                        : selectedRun.dispatchRef?.startsWith("queue:")
                          ? "Queued behind an active turn — messages appear once it starts."
                          : "The messages for this run aren't in the chat yet."}
                    </span>
                    <section className="scheduled-run-copy">
                      <span>Scheduled prompt</span>
                      <p>{selected.prompt}</p>
                    </section>
                  </div>
                )}
              </section>
            </motion.div>
          ) : (
            <motion.div
              className="scheduled-browser"
              key="browser"
              initial={off ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={viewTransition}
            >
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
                <FilterPills
                  value={filter}
                  label="Filter scheduled tasks"
                  layoutKey="browser-filter"
                  options={FILTERS.map((option) => ({
                    value: option,
                    label: option === "all" ? "All" : statusLabel(option),
                  }))}
                  onChange={setFilter}
                />
              </div>
              <Reveal show={Boolean(error && !selected)} motionScale={motionScale}>
                <p className="scheduled-error">{error}</p>
              </Reveal>
              <div className="scheduled-browser-list" aria-label="Scheduled tasks">
                <TravelingSelection
                  activeKey={railOpen && selected ? selected.id : ""}
                  className="scheduled-row-active"
                  layoutKey={`${filter}:${query}:${filtered.map((item) => item.id).join("|")}`}
                />
                <LayoutGroup id="scheduled-browser-rows">
                  <AnimatePresence initial={false} mode="popLayout">
                    {filtered.map((automation) => (
                      <motion.button
                        key={automation.id}
                        layout={off ? false : "position"}
                        className="scheduled-browser-row"
                        type="button"
                        data-selected={railOpen && automation.id === selected?.id}
                        data-traveling-selection={automation.id}
                        data-status={
                          automation.status === "needs-attention" ? "attention" : automation.status
                        }
                        initial={off ? false : { opacity: 0, y: 6, scale: 0.985 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.985, transition: { duration: 0.12 } }}
                        transition={off ? { duration: 0 } : { layout: rowSpring, ...rowSpring }}
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
                      </motion.button>
                    ))}
                  </AnimatePresence>
                </LayoutGroup>
                <AnimatePresence initial={false}>
                  {!filtered.length ? (
                    <motion.div
                      className="scheduled-empty"
                      key="empty"
                      initial={off ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, transition: { duration: 0.1 } }}
                      transition={viewTransition}
                    >
                      <CalendarClock />
                      <strong>
                        {automations.length ? "Nothing matches" : "No scheduled tasks"}
                      </strong>
                      <span>
                        {automations.length
                          ? "Try another filter or clear the search."
                          : "Create one here or ask the agent to wake up later."}
                      </span>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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
              initial={off ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.14 } }}
              transition={{ duration: 0.18 }}
              onMouseDown={(event) => {
                if (event.currentTarget === event.target) setCreating(false);
              }}
            >
              <motion.form
                className="scheduled-create-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="scheduled-create-title"
                initial={off ? false : { opacity: 0, y: 12, scale: 0.975 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{
                  opacity: 0,
                  y: 6,
                  scale: 0.985,
                  transition: { duration: 0.14, ease: [0.2, 0, 0, 1] },
                }}
                transition={off ? { duration: 0 } : settleSpring}
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
                <div className="scheduled-create-field">
                  <span id="scheduled-create-target-label">Continue in</span>
                  <Dropdown
                    aria-label="Continue in"
                    className="scheduled-create-target"
                    value={createTarget}
                    options={targetOptions}
                    onChange={(value) => {
                      setCreateTarget(value);
                      // Follow the target's own route until the user picks one.
                      setCreateRouteOverride(null);
                    }}
                  />
                  <span className="scheduled-create-hint">
                    {createTargetIsNew
                      ? "A fresh chat is created when you save; every run continues there."
                      : "Runs append to this chat's conversation."}
                  </span>
                </div>
                <div className="scheduled-create-field scheduled-create-route">
                  <RouteRow
                    label="Run with"
                    route={createRoute}
                    runtimes={runtimes}
                    catalogs={catalogs}
                    onChange={setCreateRouteOverride}
                  />
                  <div className="scheduled-policy-row">
                    <Dropdown
                      compact
                      aria-label="Permission ceiling"
                      value={createPermission}
                      options={PERMISSIONS}
                      onChange={(value) =>
                        setCreatePermission(value as AutomationRoute["permission"])
                      }
                    />
                    <Dropdown
                      compact
                      aria-label="Delegation"
                      value={createDelegation}
                      options={DELEGATION}
                      onChange={(value) =>
                        setCreateDelegation(value as AutomationRoute["delegation"])
                      }
                    />
                  </div>
                  <ToolScopePicker
                    aria-label="Tools"
                    className="scheduled-create-tools"
                    value={createTools}
                    mcps={toolInventory.mcps}
                    skills={toolInventory.skills}
                    loading={!toolInventory.loaded}
                    onChange={setCreateTools}
                  />
                </div>
                <div className="scheduled-create-timing">
                  <div className="scheduled-create-kind">
                    <FilterPills
                      value={newKind}
                      label="Schedule kind"
                      layoutKey="create-kind"
                      options={kindOptions}
                      onChange={setNewKind}
                    />
                    <span className="scheduled-create-kind-hint">
                      {newKind === "once" ? "Runs one time at" : "First run at"}
                    </span>
                  </div>
                  <Reveal
                    show={newKind === "repeat"}
                    motionScale={motionScale}
                    className="scheduled-create-repeat"
                  >
                    <div className="scheduled-interval-input">
                      <span>Every</span>
                      <input
                        aria-label="Repeat every"
                        type="number"
                        min="1"
                        value={newEvery}
                        onChange={(event) => setNewEvery(Math.max(1, Number(event.target.value)))}
                      />
                      <Dropdown
                        compact
                        aria-label="Repeat unit"
                        value={newUnit}
                        options={UNITS}
                        onChange={(value) => setNewUnit(value as IntervalUnit)}
                      />
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
                  </Reveal>
                  <input
                    aria-label={newKind === "once" ? "Run at" : "First run at"}
                    type="datetime-local"
                    value={newRunAt}
                    onChange={(event) => setNewRunAt(event.target.value)}
                  />
                </div>
                <Reveal show={Boolean(error)} motionScale={motionScale}>
                  <p className="scheduled-error">{error}</p>
                </Reveal>
                <footer>
                  <button type="button" onClick={() => setCreating(false)}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      busy ||
                      !(createTargetIsNew || createTargetTask) ||
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
