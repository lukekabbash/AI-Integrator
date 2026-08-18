import { Bot, FileDiff, Globe, Minus, Plus, X } from "lucide-react";
import { m as motion, usePresence, useReducedMotion } from "motion/react";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { DelegationView } from "../bridge";
import type { WorkPaneController } from "../useWorkPane";
import { surfaceFileName, WORK_PANE_MIN_WIDTH, type WorkSurface } from "../workPaneModel";
import { AgentGlyph } from "./AgentGlyph";
import { FileIcon } from "./FileIcon";
import { ResizeHandle } from "./ResizeHandle";
import { TabFavicon } from "./TabFavicon";
import { Tooltip } from "./Tooltip";
import { TravelingSelection } from "./TravelingSelection";
import type { WorkPaneLaunchKind } from "./WorkPaneToggle";
import { useRailCursor } from "../useRailCursor";
import "./workPane.css";

const railItemSpring = { type: "spring" as const, stiffness: 560, damping: 34, mass: 0.7 };
/** Covers the width leg of the shared panel transition, so the pane finishes
 *  sliding shut before it is taken out of the tree. */
const EXIT_MS = 360;

export interface WorkPaneProps {
  controller: WorkPaneController;
  /** Titlebar slice above the pane; the tab strip portals here when set. */
  headerTarget: HTMLElement | null;
  paneRef: RefObject<HTMLDivElement | null>;
  /** The row the pane lives in; width is clamped to 70% of it. */
  rowRef: RefObject<HTMLDivElement | null>;
  panelTransition: object;
  delegations: DelegationView[];
  browserTitles?: Record<string, string>;
  /** Each tab's site icon as a `data:` URL, keyed by tab id. */
  browserIcons?: Record<string, string>;
  /** Tabs an agent is driving right now, keyed by tab id. */
  browserBusy?: Record<string, string>;
  /** Tabs whose recent agent work turns X into minimize instead of destroy. */
  browserProtected?: Record<string, boolean>;
  /** Resolves the browser X through the native recent-agent guard. */
  onBrowserClose?: (tabId: string) => void;
  renderFile: (surface: Extract<WorkSurface, { kind: "file" }>) => ReactNode;
  renderReview: () => ReactNode;
  renderSubagent: (delegationId: string, headerHost: HTMLElement | null) => ReactNode;
  renderBrowser?: (tabId: string) => ReactNode;
  browserAvailable: boolean;
  /** Accountless chats expose only their task-scoped browser here. */
  browserOnly?: boolean;
  onLaunch: (kind: WorkPaneLaunchKind) => void;
  /** Left/Right cursor across the tab strip; see `spatialNavigation.ts`. */
  arrowNavigation?: boolean;
  /** Whether that cursor wraps past the first and last tab. */
  wrapNavigation?: boolean;
}

/**
 * The tabbed secondary surface between the transcript and the right rail.
 * Files, review, subagent conversations and browser tabs open here as peer
 * tabs; the transcript is never displaced. Closing tabs never stops the
 * process behind them. Chrome (tab strip, grip) has a body; content is flat.
 */
export function WorkPane({
  controller,
  headerTarget,
  paneRef,
  rowRef,
  panelTransition,
  delegations,
  browserTitles,
  browserIcons,
  browserBusy,
  browserProtected,
  onBrowserClose,
  renderFile,
  renderReview,
  renderSubagent,
  renderBrowser,
  browserAvailable,
  browserOnly = false,
  onLaunch,
  arrowNavigation = true,
  wrapNavigation = true,
}: WorkPaneProps) {
  const { state, active } = controller;
  const stripRef = useRef<HTMLDivElement>(null);
  // The strip is this pane's bezel row: Left and Right walk the open surfaces.
  const onStripKeyDown = useRailCursor(stripRef, {
    enabled: arrowNavigation,
    wrap: wrapNavigation,
    orientation: "horizontal",
  });
  const reduceMotion = Boolean(useReducedMotion());
  const [maxWidth, setMaxWidth] = useState<number | null>(null);
  // This component returns a fragment (the titlebar portal plus the pane), so
  // AnimatePresence cannot infer when the exit finished and would leave a
  // faded-out pane holding its width forever. Own the departure instead: play
  // the fade, then release the node on a timer we control.
  const [present, safeToRemove] = usePresence();
  // True once the opening slide has finished, so a resize drag is not tweened.
  const [entered, setEntered] = useState(false);
  // The pane lives inside `<AnimatePresence initial={false}>`, which suppresses
  // a child's `initial` — so the opening frame has to come from state instead,
  // or the pane appears at full width and only fades. One frame closed, then
  // the same slide the closing side uses.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [reduceMotion]);
  const open = present && shown;
  useEffect(() => {
    if (present) return;
    const timeout = window.setTimeout(() => safeToRemove?.(), reduceMotion ? 0 : EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [present, safeToRemove, reduceMotion]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !state.open) return;
    const measure = () => setMaxWidth(Math.max(WORK_PANE_MIN_WIDTH, row.clientWidth * 0.7));
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(row);
    return () => observer?.disconnect();
  }, [rowRef, state.open]);

  const width = Math.min(state.width, maxWidth ?? state.width);
  const onResize = useCallback((delta: number) => controller.nudgeWidth(delta), [controller]);

  // Middle-click closes, like the file tabs.
  const onTabAuxClick = (event: ReactMouseEvent, id: string) => {
    if (event.button === 1) {
      event.preventDefault();
      controller.close(id);
    }
  };

  const strip = state.open ? (
    <div
      className="work-pane-strip"
      role="tablist"
      aria-label="Open surfaces"
      ref={stripRef}
      data-nav-region="workPane"
      onKeyDown={onStripKeyDown}
      // The strip sits in the titlebar, so its empty space moves the window
      // like the rest of the bar. A press only starts a drag on the element
      // holding the attribute, which leaves the tabs clickable.
      data-tauri-drag-region
    >
      <div className="work-pane-strip-tabs" data-tauri-drag-region>
        {/* One selection layer for the whole strip, so switching tabs slides the
            colour across rather than snapping it — the same pill the sidebar's
            chat list uses, in the same colour. */}
        <TravelingSelection
          activeKey={state.activeId ?? ""}
          className="tab-strip-selection"
          clampWidth={false}
          pace="quick"
          layoutKey={`${state.surfaces.map((surface) => surface.id).join("|")}:${width}`}
        />
        {state.surfaces.map((surface, index) => {
          const label = surfaceLabel(surface, delegations, browserTitles);
          // Files close by path so two same-named files stay distinguishable.
          const closeLabel = surface.kind === "file" ? surface.path : label;
          const preservesAgentWork =
            surface.kind === "browser" && browserProtected?.[surface.tabId] === true;
          const closeAction =
            surface.kind === "browser" && preservesAgentWork
              ? `Minimize ${label}`
              : `Close ${closeLabel}`;
          const activeTab = surface.id === state.activeId;
          // A tab reports whoever has it, and that includes the user when they
          // are the one typing in the page. Only an agent's turn is worth a
          // marker: the person already knows where their own hands are.
          const heldBy = surface.kind === "browser" ? browserBusy?.[surface.tabId] : undefined;
          const agentAt = heldBy && heldBy !== "you" ? heldBy : undefined;
          return (
            <motion.div
              key={surface.id}
              className="file-reader-tab work-pane-tab"
              data-active={activeTab ? "true" : undefined}
              data-traveling-selection={surface.id}
              data-kind={surface.kind}
              // A tab an agent is working in says so, so the user can watch
              // that one rather than wonder which page is moving.
              data-busy={agentAt ? "true" : undefined}
              title={agentAt ? `${agentAt} is working in this tab` : undefined}
              initial={reduceMotion ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduceMotion ? { duration: 0 } : { ...railItemSpring, delay: index * 0.01 }
              }
              layout={reduceMotion ? false : "position"}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab}
                data-nav-item
                data-nav-label={label}
                data-nav-active={activeTab ? "true" : undefined}
                title={surfaceHint(surface, label, delegations) ?? surfaceTitle(surface, label)}
                onClick={() => controller.activate(surface.id)}
                onAuxClick={(event) => onTabAuxClick(event, surface.id)}
              >
                <SurfaceGlyph
                  surface={surface}
                  delegations={delegations}
                  browserIcons={browserIcons}
                />
                <span>{label}</span>
              </button>
              {/* Two verbs, not one overloaded X. Minus sends the page to the
                  compact browser with everything still running; X ends it. Both
                  stay out of the way until the tab is hovered, focused or
                  active, so a resting strip shows titles rather than controls —
                  the sidebar's rows behave the same way. */}
              {surface.kind === "browser" ? (
                <button
                  type="button"
                  className="file-reader-tab-close work-pane-tab-minimize"
                  aria-label={`Minimize ${label}`}
                  title="Minimize to the compact browser"
                  onClick={(event) => {
                    event.stopPropagation();
                    controller.close(surface.id);
                  }}
                >
                  <Minus aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                className="file-reader-tab-close"
                aria-label={closeAction}
                title={
                  surface.kind === "browser" && preservesAgentWork
                    ? "Keep recent agent work in the compact browser"
                    : undefined
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (surface.kind === "browser" && onBrowserClose) {
                    onBrowserClose(surface.tabId);
                  } else {
                    controller.close(surface.id);
                  }
                }}
              >
                <X aria-hidden="true" />
              </button>
            </motion.div>
          );
        })}
        <Tooltip label="New tab" hint="Choose what opens here" placement="bottom">
          <button
            type="button"
            className="icon-button subtle tiny work-pane-strip-new"
            aria-label="New tab"
            onClick={() => controller.openNew()}
          >
            <Plus aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </div>
  ) : null;

  const style = { "--work-pane-width": `${width}px` } as CSSProperties;

  return (
    <>
      {strip && headerTarget ? createPortal(strip, headerTarget) : null}
      <motion.div
        ref={paneRef}
        className="work-pane subagent-workspace-pane"
        data-empty={state.surfaces.length === 0 ? "true" : undefined}
        // The seam takes its colour from whatever is open, so a browser tab
        // carries its chrome fill all the way to the edge of the pane.
        data-kind={active?.kind ?? "launcher"}
        style={style}
        // The pane opens and closes by width, the way the rail beside it does,
        // so it slides rather than appearing at full size and fading. Once it
        // has arrived the width leg goes instant: a drag has to track the
        // pointer, and a tween here would make the edge feel like it is on a
        // rubber band.
        initial={false}
        animate={{ opacity: open ? 1 : 0, width: open ? width : 0 }}
        transition={
          entered && open ? { ...panelTransition, width: { duration: 0 } } : panelTransition
        }
        // Only the arrival counts. The closed first frame finishes instantly,
        // and taking that as "entered" would hand the opening slide a
        // zero-length width tween — which is the pop this replaced.
        onAnimationComplete={() => {
          if (open) setEntered(true);
        }}
      >
        {/* The seam: one hairline with the drag pill centred on it. It hangs
            past the pane's left edge into the row, because a native browser
            surface paints above HTML and would bury anything drawn inside. */}
        <div className="work-pane-grip">
          <ResizeHandle
            axis="horizontal"
            label="Resize work pane"
            valueNow={Math.round(width)}
            valueMin={WORK_PANE_MIN_WIDTH}
            valueMax={maxWidth ? Math.round(maxWidth) : undefined}
            onResize={onResize}
          />
        </div>
        {!headerTarget ? strip : null}
        <div className="work-pane-content" data-kind={active?.kind ?? "launcher"}>
          {!present ? null : active ? (
            <Suspense
              fallback={
                <div className="route-loading" role="status" aria-live="polite">
                  Loading…
                </div>
              }
            >
              <SurfaceBody
                surface={active}
                renderFile={renderFile}
                renderReview={renderReview}
                renderSubagent={renderSubagent}
                renderBrowser={renderBrowser}
                renderNew={() => (
                  <WorkPaneLauncher
                    delegations={delegations}
                    browserAvailable={browserAvailable}
                    browserOnly={browserOnly}
                    onLaunch={onLaunch}
                    onOpenSubagent={(id) => controller.openSubagent(id)}
                    reduceMotion={reduceMotion}
                  />
                )}
              />
            </Suspense>
          ) : (
            <WorkPaneLauncher
              delegations={delegations}
              browserAvailable={browserAvailable}
              browserOnly={browserOnly}
              onLaunch={onLaunch}
              onOpenSubagent={(id) => controller.openSubagent(id)}
              reduceMotion={reduceMotion}
            />
          )}
        </div>
      </motion.div>
    </>
  );
}

function SurfaceBody({
  surface,
  renderFile,
  renderReview,
  renderSubagent,
  renderBrowser,
  renderNew,
}: {
  surface: WorkSurface;
  renderFile: WorkPaneProps["renderFile"];
  renderReview: WorkPaneProps["renderReview"];
  renderSubagent: WorkPaneProps["renderSubagent"];
  renderBrowser: WorkPaneProps["renderBrowser"];
  renderNew: () => ReactNode;
}) {
  switch (surface.kind) {
    case "file":
      return <>{renderFile(surface)}</>;
    case "review":
      return <>{renderReview()}</>;
    case "subagent":
      // No header host: the title, role, runtime and status are on the tab and
      // its tooltip, and the tab's own close button ends the surface.
      return <>{renderSubagent(surface.delegationId, null)}</>;
    case "new":
      return <>{renderNew()}</>;
    case "browser":
      return renderBrowser ? (
        <>{renderBrowser(surface.tabId)}</>
      ) : (
        <div className="work-pane-notice" role="status">
          <strong>Browser tabs need the desktop app</strong>
          <small>The web preview cannot host a native browser tab.</small>
        </div>
      );
  }
}

function surfaceLabel(
  surface: WorkSurface,
  delegations: DelegationView[],
  browserTitles: Record<string, string> | undefined,
): string {
  switch (surface.kind) {
    case "file":
      return surfaceFileName(surface.path);
    case "review":
      return "Review";
    case "subagent":
      return delegations.find((d) => d.id === surface.delegationId)?.title ?? "Subagent";
    case "browser":
      return browserTitles?.[surface.tabId] || "Browser";
    case "new":
      return "New tab";
  }
}

function surfaceTitle(surface: WorkSurface, label: string): string {
  return surface.kind === "file" ? surface.path : label;
}

/**
 * What a subagent tab says on hover. This used to be a row inside the pane; the
 * tab carries it now, so the surface is all transcript.
 */
function surfaceHint(
  surface: WorkSurface,
  label: string,
  delegations: DelegationView[],
): string | undefined {
  if (surface.kind !== "subagent") return undefined;
  const delegation = delegations.find((entry) => entry.id === surface.delegationId);
  if (!delegation) return undefined;
  const detail = [delegation.profileLabel, delegation.runtime, delegation.status]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return detail
    ? `${label}
${detail}`
    : label;
}

function SurfaceGlyph({
  surface,
  delegations,
  browserIcons,
}: {
  surface: WorkSurface;
  delegations: DelegationView[];
  browserIcons?: Record<string, string>;
}) {
  switch (surface.kind) {
    case "file":
      return <FileIcon fileName={surface.path} />;
    case "review":
      return <FileDiff aria-hidden="true" />;
    case "new":
      return <Plus aria-hidden="true" />;
    case "subagent": {
      const index = delegations.findIndex((entry) => entry.id === surface.delegationId);
      const delegation = index === -1 ? undefined : delegations[index];
      if (!delegation) return <Bot aria-hidden="true" />;
      // The same sigil the agents rail draws, animated the same way, with a bot
      // face badged into its lower-right corner. The wrapper is the size of an
      // ordinary tab glyph, so the strip's rhythm does not change.
      return (
        <span className="work-pane-agent-glyph" aria-hidden="true">
          <AgentGlyph
            variant={index % 10}
            shade={0}
            provider={delegation.runtime}
            state={delegation.status}
            label={delegation.title}
          />
          <Bot className="work-pane-agent-face" aria-hidden="true" />
        </span>
      );
    }
    case "browser":
      return <TabFavicon src={browserIcons?.[surface.tabId]} />;
  }
}

/* -------------------------------------------------------------------------- */
/* Launcher                                                                   */
/* -------------------------------------------------------------------------- */

function WorkPaneLauncher({
  delegations,
  browserAvailable,
  browserOnly,
  onLaunch,
  onOpenSubagent,
  reduceMotion,
}: {
  delegations: DelegationView[];
  browserAvailable: boolean;
  browserOnly: boolean;
  onLaunch: (kind: WorkPaneLaunchKind) => void;
  onOpenSubagent: (delegationId: string) => void;
  reduceMotion: boolean;
}) {
  const live = browserOnly ? [] : delegations.filter((d) => d.childTaskId);
  const options: Array<{
    kind: WorkPaneLaunchKind;
    icon: ReactNode;
    title: string;
    hint: string;
    disabled?: boolean;
  }> = [
    {
      kind: "browser",
      icon: <Globe aria-hidden="true" />,
      title: "Browser",
      hint: browserAvailable
        ? "Open a page or a local dev server the agent can drive too"
        : "Available in the desktop app",
      disabled: !browserAvailable,
    },
    ...(browserOnly
      ? []
      : ([
          {
            kind: "review",
            icon: <FileDiff aria-hidden="true" />,
            title: "Review changes",
            hint: "The unified diff for this worktree",
          },
          {
            kind: "files",
            icon: <FileIcon fileName="index.ts" />,
            title: "Files",
            hint: "Browse the project tree in the rail and open files here",
          },
          {
            kind: "subagents",
            icon: <Bot aria-hidden="true" />,
            title: "Subagents",
            hint: live.length ? `${live.length} running` : "See the agents rail",
          },
        ] satisfies Array<{
          kind: WorkPaneLaunchKind;
          icon: ReactNode;
          title: string;
          hint: string;
          disabled?: boolean;
        }>)),
  ];
  return (
    <div className="work-pane-launcher">
      <span className="work-pane-launcher-eyebrow">Open in this pane</span>
      <ul className="work-pane-launcher-list">
        {options.map((option, index) => (
          <motion.li
            key={option.kind}
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { ...railItemSpring, delay: index * 0.02 }}
          >
            <button
              type="button"
              className="work-pane-launcher-option"
              disabled={option.disabled}
              onClick={() => onLaunch(option.kind)}
            >
              <span className="work-pane-launcher-icon">{option.icon}</span>
              <span>
                <strong>{option.title}</strong>
                <small>{option.hint}</small>
              </span>
            </button>
          </motion.li>
        ))}
      </ul>
      {live.length > 0 ? (
        <>
          <span className="work-pane-launcher-eyebrow">Running now</span>
          <ul className="work-pane-launcher-list work-pane-launcher-list--compact">
            {live.slice(0, 6).map((delegation) => (
              <li key={delegation.id}>
                <button
                  type="button"
                  className="work-pane-launcher-option"
                  onClick={() => onOpenSubagent(delegation.id)}
                >
                  <span className="work-pane-launcher-icon">
                    <Bot aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{delegation.title}</strong>
                    <small>{delegation.status.replaceAll("_", " ")}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
