import { Bot, FileDiff, Globe, X } from "lucide-react";
import { m as motion, usePresence, useReducedMotion } from "motion/react";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { FileIcon } from "./FileIcon";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";
import type { WorkPaneLaunchKind } from "./WorkPaneToggle";
import "./workPane.css";

const railItemSpring = { type: "spring" as const, stiffness: 560, damping: 34, mass: 0.7 };
/** Matches the opacity leg of the shared panel transition. */
const EXIT_MS = 220;

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
  renderFile: (surface: Extract<WorkSurface, { kind: "file" }>) => ReactNode;
  renderReview: () => ReactNode;
  renderSubagent: (delegationId: string, headerHost: HTMLElement | null) => ReactNode;
  renderBrowser?: (tabId: string) => ReactNode;
  browserAvailable: boolean;
  onLaunch: (kind: WorkPaneLaunchKind) => void;
  /** Controls docked at the end of the strip (the titlebar cluster the pane covers). */
  trailing?: ReactNode;
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
  renderFile,
  renderReview,
  renderSubagent,
  renderBrowser,
  browserAvailable,
  onLaunch,
  trailing,
}: WorkPaneProps) {
  const { state, active } = controller;
  const [subagentHeaderHost, setSubagentHeaderHost] = useState<HTMLDivElement | null>(null);
  const reduceMotion = Boolean(useReducedMotion());
  const [maxWidth, setMaxWidth] = useState<number | null>(null);
  // This component returns a fragment (the titlebar portal plus the pane), so
  // AnimatePresence cannot infer when the exit finished and would leave a
  // faded-out pane holding its width forever. Own the departure instead: play
  // the fade, then release the node on a timer we control.
  const [present, safeToRemove] = usePresence();
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
  const onResize = useCallback(
    (delta: number) => controller.setWidth(controller.state.width - delta),
    [controller],
  );

  // Middle-click closes, like the file tabs.
  const onTabAuxClick = (event: ReactMouseEvent, id: string) => {
    if (event.button === 1) {
      event.preventDefault();
      controller.close(id);
    }
  };

  const strip = state.open ? (
    <div className="work-pane-strip" role="tablist" aria-label="Open surfaces">
      <div className="work-pane-strip-tabs">
        {state.surfaces.map((surface, index) => {
          const label = surfaceLabel(surface, delegations, browserTitles);
          // Files close by path so two same-named files stay distinguishable.
          const closeLabel = surface.kind === "file" ? surface.path : label;
          const activeTab = surface.id === state.activeId;
          return (
            <motion.div
              key={surface.id}
              className="file-reader-tab work-pane-tab"
              data-active={activeTab ? "true" : undefined}
              data-kind={surface.kind}
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
                title={surfaceTitle(surface, label)}
                onClick={() => controller.activate(surface.id)}
                onAuxClick={(event) => onTabAuxClick(event, surface.id)}
              >
                <SurfaceGlyph surface={surface} />
                <span>{label}</span>
              </button>
              <button
                type="button"
                className="file-reader-tab-close"
                aria-label={`Close ${closeLabel}`}
                onClick={(event) => {
                  event.stopPropagation();
                  controller.close(surface.id);
                }}
              >
                <X aria-hidden="true" />
              </button>
            </motion.div>
          );
        })}
      </div>
      <div className="work-pane-strip-trailing">
        {state.surfaces.length > 0 ? (
          <Tooltip label="Close all tabs" hint="Processes keep running" placement="bottom">
            <button
              type="button"
              className="icon-button subtle tiny work-pane-strip-close-all"
              aria-label="Close all tabs"
              onClick={() => controller.closeAll()}
            >
              <X aria-hidden="true" />
            </button>
          </Tooltip>
        ) : null}
        {trailing}
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
        style={style}
        initial={{ opacity: 0 }}
        animate={{ opacity: present ? 1 : 0 }}
        transition={panelTransition}
      >
        <ResizeHandle
          axis="horizontal"
          label="Resize work pane"
          valueNow={Math.round(width)}
          valueMin={WORK_PANE_MIN_WIDTH}
          valueMax={maxWidth ? Math.round(maxWidth) : undefined}
          onResize={onResize}
        />
        {!headerTarget ? strip : null}
        <div
          className="work-pane-subheader"
          ref={setSubagentHeaderHost}
          data-visible={active?.kind === "subagent" ? "true" : undefined}
        />
        <div className="work-pane-content" data-kind={active?.kind ?? "launcher"}>
          {active ? (
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
                subagentHeaderHost={subagentHeaderHost}
              />
            </Suspense>
          ) : (
            <WorkPaneLauncher
              delegations={delegations}
              browserAvailable={browserAvailable}
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
  subagentHeaderHost,
}: {
  surface: WorkSurface;
  renderFile: WorkPaneProps["renderFile"];
  renderReview: WorkPaneProps["renderReview"];
  renderSubagent: WorkPaneProps["renderSubagent"];
  renderBrowser: WorkPaneProps["renderBrowser"];
  subagentHeaderHost: HTMLElement | null;
}) {
  switch (surface.kind) {
    case "file":
      return <>{renderFile(surface)}</>;
    case "review":
      return <>{renderReview()}</>;
    case "subagent":
      return <>{renderSubagent(surface.delegationId, subagentHeaderHost)}</>;
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
  }
}

function surfaceTitle(surface: WorkSurface, label: string): string {
  return surface.kind === "file" ? surface.path : label;
}

function SurfaceGlyph({ surface }: { surface: WorkSurface }) {
  switch (surface.kind) {
    case "file":
      return <FileIcon fileName={surface.path} />;
    case "review":
      return <FileDiff aria-hidden="true" />;
    case "subagent":
      return <Bot aria-hidden="true" />;
    case "browser":
      return <Globe aria-hidden="true" />;
  }
}

/* -------------------------------------------------------------------------- */
/* Launcher                                                                   */
/* -------------------------------------------------------------------------- */

function WorkPaneLauncher({
  delegations,
  browserAvailable,
  onLaunch,
  onOpenSubagent,
  reduceMotion,
}: {
  delegations: DelegationView[];
  browserAvailable: boolean;
  onLaunch: (kind: WorkPaneLaunchKind) => void;
  onOpenSubagent: (delegationId: string) => void;
  reduceMotion: boolean;
}) {
  const live = delegations.filter((d) => d.childTaskId);
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
