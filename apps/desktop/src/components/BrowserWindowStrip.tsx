import { Minus, X } from "lucide-react";
import { m as motion } from "motion/react";
import { useCallback, type ReactElement, type ReactNode } from "react";

import type { BrowserTab } from "../bridge";
import type { TabDragHandlers } from "../useTabDrag";
import { truncateGroupName, type StripGroup } from "./browserWindowGroups";
import { tabLabel } from "./browserWindowTabs";
import { TabFavicon } from "./TabFavicon";
import { Tooltip } from "./Tooltip";

/** The strip's enter/exit motion: a tab grows in from its leading edge. */
const tabSpring = { type: "spring" as const, stiffness: 540, damping: 38, mass: 0.7 };

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Where a strip tooltip is drawn. The strip sits above a native page that
 *  covers any HTML bubble under it, so while a live tab is in front the guest
 *  draws the bubble in its own layer (`hostTooltip`); with nothing live to
 *  cover it, the ordinary bubble does. */
export interface TooltipHost {
  taskId: string;
  tabId: string;
  /** Draws (or clears, with null) the bubble in the live page's own layer. */
  draw: (tooltip: { label: string; hint?: string; x: number } | null) => void;
}

interface StripTooltipProps {
  label: string;
  hint?: string;
  host: TooltipHost | null;
  children: ReactElement;
}

export function StripTooltip({ label, hint, host, children }: StripTooltipProps) {
  const onOpenChange = useCallback(
    (open: boolean, anchor?: DOMRect, shown?: ReactNode) => {
      if (!host) return;
      if (!open || !anchor || typeof shown !== "string") {
        host.draw(null);
        return;
      }
      host.draw({ label: shown, hint, x: anchor.left + anchor.width / 2 });
    },
    [hint, host],
  );
  return (
    <Tooltip
      label={label}
      hint={hint}
      placement="bottom"
      renderBubble={host === null}
      onOpenChange={host ? onOpenChange : undefined}
    >
      {children}
    </Tooltip>
  );
}

export interface GroupPillProps {
  group: StripGroup<BrowserTab>;
  tooltipHost: TooltipHost | null;
  reduceMotion: boolean;
  onToggle: (groupId: string) => void;
  /** Right-click: the group menu, at window coordinates. */
  onMenu: (x: number, y: number) => void;
}

/** One group's name, in its colour. Click folds the group's tabs away and
 *  back; a dot says an agent is working in one of them. */
export function GroupPill({ group, tooltipHost, reduceMotion, onToggle, onMenu }: GroupPillProps) {
  const count = group.tabs.length;
  const tabsWord = count === 1 ? "tab" : "tabs";
  return (
    <StripTooltip
      label={group.name}
      hint={`${count} ${tabsWord} · click to ${group.collapsed ? "expand" : "collapse"}`}
      host={tooltipHost}
    >
      <motion.button
        type="button"
        layout={!reduceMotion}
        className="browser-group-pill"
        data-group-id={group.id}
        data-group-kind={group.kind}
        data-color={group.colorIndex}
        data-collapsed={group.collapsed ? "true" : undefined}
        data-live={group.live ? "true" : undefined}
        data-active-hidden={group.activeHidden ? "true" : undefined}
        aria-pressed={!group.collapsed}
        aria-label={`${group.name}, ${count} ${tabsWord}, ${
          group.collapsed ? "collapsed" : "expanded"
        }`}
        transition={reduceMotion ? { duration: 0 } : tabSpring}
        onClick={() => onToggle(group.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(rect.left, rect.bottom + 4);
        }}
      >
        <span className="browser-group-pill-name">{truncateGroupName(group.name)}</span>
        {group.live ? <span className="browser-group-pill-dot" aria-hidden="true" /> : null}
      </motion.button>
    </StripTooltip>
  );
}

export interface StripTabProps {
  tab: BrowserTab;
  group: StripGroup<BrowserTab>;
  active: boolean;
  /** The native side would keep this tab on close for recent agent work. */
  preservesAgentWork: boolean;
  /** "<agent> is working here — <task>" while an agent holds the tab. */
  driver: string | null;
  tooltipHost: TooltipHost | null;
  reduceMotion: boolean;
  dragHandlers: TabDragHandlers;
  /** A dragged tab is about to land in front of this one. */
  dragGap: boolean;
  onSelect: () => void;
  onDock: () => void;
  onClose: () => void;
}

export function StripTab({
  tab,
  group,
  active,
  preservesAgentWork,
  driver,
  tooltipHost,
  reduceMotion,
  dragHandlers,
  dragGap,
  onSelect,
  onDock,
  onClose,
}: StripTabProps) {
  const label = tabLabel(tab);
  return (
    <motion.div
      layout={!reduceMotion}
      className="file-reader-tab browser-window-tab"
      data-active={active ? "true" : undefined}
      data-traveling-selection={tab.id}
      data-task-id={tab.taskId}
      data-group-id={group.id}
      data-color={group.colorIndex}
      data-busy={driver ? "true" : undefined}
      data-drag-gap={dragGap ? "before" : undefined}
      {...dragHandlers}
      initial={reduceMotion ? false : { opacity: 0, scaleX: 0.6, flexGrow: 0, minWidth: 0 }}
      animate={{ opacity: 1, scaleX: 1, flexGrow: 1, minWidth: 96 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scaleX: 0.6, flexGrow: 0, minWidth: 0 }}
      transition={reduceMotion ? { duration: 0 } : tabSpring}
      style={{ originX: 0 }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <StripTooltip
        label={`${group.name} · ${label}`}
        hint={driver ?? hostOf(tab.url)}
        host={tooltipHost}
      >
        <button type="button" role="tab" aria-selected={active} onClick={onSelect}>
          <TabFavicon src={tab.favicon} />
          <span>{label}</span>
        </button>
      </StripTooltip>
      {/* Two verbs, as in the pane: Minus sends the page back to the pane with
          everything still running; X ends it. */}
      <StripTooltip label="Send to the pane" hint="Keeps the page running" host={tooltipHost}>
        <button
          type="button"
          className="file-reader-tab-close browser-window-tab-minimize"
          aria-label={`Send ${label} to the app`}
          onClick={(event) => {
            event.stopPropagation();
            onDock();
          }}
        >
          <Minus aria-hidden="true" />
        </button>
      </StripTooltip>
      <StripTooltip
        label={preservesAgentWork ? "Minimize" : "Close"}
        hint={preservesAgentWork ? "Recent agent work is kept in the compact browser" : "Ctrl+W"}
        host={tooltipHost}
      >
        <button
          type="button"
          className="file-reader-tab-close"
          aria-label={preservesAgentWork ? `Minimize ${label}` : `Close ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X aria-hidden="true" />
        </button>
      </StripTooltip>
    </motion.div>
  );
}
