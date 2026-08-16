import { ChevronDown, RefreshCw, X } from "lucide-react";
import { m as motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  aggregateUsageHistory,
  computeStreaks,
  formatPercent,
  formatPeriodLabel,
  formatUsageTokens,
  formatUsd,
  formatWindowRange,
  groupPeriods,
  heatmapWeeks,
  makeUsageWindow,
  periodWindow,
  USAGE_WINDOW_OPTIONS,
  usageProviderName,
  type UsageDashboardModel,
  type UsageHistoryProvider,
  type UsageHistoryReport,
  type UsageMetric,
  type UsagePeriod,
  type UsageProviderRollup,
  type UsageResolution,
  type UsageStreaks,
  type UsageWindow,
  type UsageWindowDays,
} from "../usageHistory";
import { ProviderIcon } from "./Dropdown";
import { Tooltip } from "./Tooltip";
import "./usageDashboard.css";

/** Same gel as the rest of the chrome: one overshoot, then settle. */
const settleSpring = { type: "spring" as const, stiffness: 540, damping: 38, mass: 0.7 };
const PROVIDER_ORDER: readonly UsageHistoryProvider[] = ["codex", "claude"];
const SKELETON_RIBBON = [
  18, 26, 12, 34, 40, 22, 8, 30, 46, 52, 28, 14, 36, 58, 44, 20, 10, 32, 50, 62, 38, 16, 24, 42, 30,
  12, 48, 56, 34, 20,
];
/** Beyond this many bars the ribbon folds days into weeks so a bar stays readable. */
const RIBBON_MAX_BARS = 120;

type UsageView = "ribbon" | "heatmap" | "cumulative";
const VIEW_OPTIONS: ReadonlyArray<{ value: UsageView; label: string }> = [
  { value: "ribbon", label: "Ribbon" },
  { value: "heatmap", label: "Heatmap" },
  { value: "cumulative", label: "Cumulative" },
];

export interface UsageDashboardProps {
  /** Loads hourly slices for a window; the dashboard buckets and prices them. */
  loadHistory: (sinceMs: number, untilMs: number) => Promise<UsageHistoryReport>;
  /** Bump to force a reload from the parent's Refresh control. */
  refreshToken?: number;
}

/**
 * What the installed CLIs recorded on this machine, priced at API list rate.
 *
 * The runtime is the noun, so the ledger is organised by runtime: a graph
 * (ribbon, heatmap, or cumulative) states the shape of the window, a figures
 * line gives the totals in row-title type (no hero numeral), and each runtime
 * is a quiet row with its token-mix band that discloses a tree of models.
 * Selecting a day or hour in the graph focuses the figures and the ledger on
 * it. Content stays flat on the canvas; only the controls have a body.
 */
export function UsageDashboard({ loadHistory, refreshToken = 0 }: UsageDashboardProps) {
  const reduceMotion = Boolean(useReducedMotion());
  const [days, setDays] = useState<UsageWindowDays>(30);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [view, setView] = useState<UsageView>("ribbon");
  const [window, setWindow] = useState<UsageWindow>(() => makeUsageWindow(30));
  const [focusStart, setFocusStart] = useState<number | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [openRuntimes, setOpenRuntimes] = useState<ReadonlySet<UsageHistoryProvider>>(
    () => new Set(),
  );
  // The request key changes with the window or a refresh; a result is only
  // current when it carries the same key, so loading is derived, not stored.
  const requestKey = `${window.sinceMs}:${window.untilMs}:${refreshToken}:${localRefresh}`;
  const [result, setResult] = useState<{
    key: string;
    report: UsageHistoryReport | null;
    error: string | null;
  } | null>(null);

  const selectDays = useCallback((next: UsageWindowDays) => {
    setDays(next);
    setWindow(makeUsageWindow(next));
    setFocusStart(null);
    // A year of days is a calendar, not a ribbon.
    if (next === 365) setView((current) => (current === "ribbon" ? "heatmap" : current));
  }, []);
  const toggleRuntime = useCallback((provider: UsageHistoryProvider) => {
    setOpenRuntimes((previous) => {
      const next = new Set(previous);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }, []);
  const toggleFocus = useCallback((startMs: number) => {
    setFocusStart((current) => (current === startMs ? null : startMs));
  }, []);

  useEffect(() => {
    let active = true;
    loadHistory(window.sinceMs, window.untilMs)
      .then((report) => {
        if (active) setResult({ key: requestKey, report, error: null });
      })
      .catch((cause) => {
        if (!active) return;
        setResult((previous) => ({
          key: requestKey,
          report: previous?.report ?? null,
          error: cause instanceof Error ? cause.message : "Usage history is unavailable.",
        }));
      });
    return () => {
      active = false;
    };
  }, [loadHistory, window, requestKey]);

  const loading = result?.key !== requestKey;
  const report = result?.report ?? null;
  const error = result?.key === requestKey ? result.error : null;
  const model = useMemo(
    () => (report ? aggregateUsageHistory(report, window) : null),
    [report, window],
  );
  const focus = useMemo(() => {
    if (!report || !model || focusStart === null) return null;
    if (!model.periods.some((period) => period.startMs === focusStart)) return null;
    return {
      startMs: focusStart,
      model: aggregateUsageHistory(report, periodWindow(window, focusStart)),
    };
  }, [report, model, window, focusStart]);
  const streaks = useMemo(() => (model ? computeStreaks(model.periods) : null), [model]);
  const shown = focus?.model ?? model;
  const showSkeleton = loading && !model;

  return (
    <section className="settings-section usage-dashboard" aria-busy={loading}>
      <header className="usage-dashboard-header">
        <div>
          <h2>What your CLIs recorded</h2>
          <p>
            Read from the Codex and Claude Code transcripts on this computer ·{" "}
            {model ? formatWindowRange(window) : "scanning local history"}
          </p>
        </div>
        <div className="usage-dashboard-controls">
          <div className="segmented compact" role="group" aria-label="Usage window">
            {USAGE_WINDOW_OPTIONS.map((option) => (
              <button
                key={option.days}
                type="button"
                data-active={option.days === days ? "true" : undefined}
                aria-pressed={option.days === days}
                onClick={() => selectDays(option.days)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="segmented compact" role="group" aria-label="Figure shown">
            {(["cost", "tokens"] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-active={option === metric ? "true" : undefined}
                aria-pressed={option === metric}
                onClick={() => setMetric(option)}
              >
                {option === "cost" ? "Cost" : "Tokens"}
              </button>
            ))}
          </div>
          <button
            className="icon-button subtle usage-dashboard-refresh"
            type="button"
            aria-label="Rescan local usage"
            disabled={loading}
            onClick={() => setLocalRefresh((value) => value + 1)}
          >
            <RefreshCw className={loading ? "spin" : ""} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error ? (
        <p className="settings-action-message" role="status">
          {error}
        </p>
      ) : null}

      {showSkeleton ? (
        <UsageSkeleton />
      ) : model && shown && streaks ? (
        <>
          <UsageGraph
            model={model}
            metric={metric}
            view={view}
            onView={setView}
            resolution={window.resolution}
            focusStart={focus?.startMs ?? null}
            onFocus={toggleFocus}
            reduceMotion={reduceMotion}
          />
          <FiguresLine
            model={shown}
            metric={metric}
            streaks={streaks}
            resolution={window.resolution}
            focusStart={focus?.startMs ?? null}
            onClearFocus={() => setFocusStart(null)}
          />
          <RuntimeLedger
            model={shown}
            metric={metric}
            focused={focus !== null}
            openRuntimes={openRuntimes}
            onToggle={toggleRuntime}
          />
          <UsageCoverage model={model} />
        </>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Graph: ribbon, heatmap, cumulative                                         */
/* -------------------------------------------------------------------------- */

function periodValue(
  period: UsagePeriod | { totalTokens: number; costUsd: number } | undefined,
  metric: UsageMetric,
): number {
  if (!period) return 0;
  return metric === "cost" ? period.costUsd : period.totalTokens;
}

function runningTotals(values: number[]): number[] {
  const out: number[] = [];
  values.reduce((sum, value) => {
    const next = sum + value;
    out.push(next);
    return next;
  }, 0);
  return out;
}

function formatMetric(amount: number, metric: UsageMetric): string {
  return metric === "cost" ? formatUsd(amount) : formatUsageTokens(amount);
}

function periodTooltip(period: UsagePeriod, metric: UsageMetric, resolution: UsageResolution) {
  const total = periodValue(period, metric);
  const detail = PROVIDER_ORDER.filter((provider) => period.byProvider[provider])
    .map(
      (provider) =>
        `${usageProviderName(provider)} ${formatMetric(periodValue(period.byProvider[provider], metric), metric)}`,
    )
    .join(" · ");
  return {
    label: `${formatPeriodLabel(period.startMs, resolution)} · ${formatMetric(total, metric)}`,
    hint: detail || undefined,
  };
}

interface GraphProps {
  model: UsageDashboardModel;
  metric: UsageMetric;
  resolution: UsageResolution;
  focusStart: number | null;
  onFocus: (startMs: number) => void;
  reduceMotion: boolean;
}

/** The graph slot: a view switch on the caption row, then the chosen graph. */
function UsageGraph({
  view,
  onView,
  ...graph
}: GraphProps & { view: UsageView; onView: (view: UsageView) => void }) {
  const { model, metric, resolution } = graph;
  const active = model.periods.filter((period) => period.totalTokens > 0).length;
  const peak = Math.max(...model.periods.map((period) => periodValue(period, metric)), 0);
  const noun = resolution === "hour" ? "hour" : "day";
  const nounPlural = resolution === "hour" ? "hours" : "days";
  return (
    <div className="usage-graph" data-view={view}>
      <div className="usage-graph-caption">
        <div className="segmented compact" role="group" aria-label="Graph">
          {VIEW_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              data-active={option.value === view ? "true" : undefined}
              aria-pressed={option.value === view}
              onClick={() => onView(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="usage-graph-note" aria-hidden="true">
          Peak {noun} {formatMetric(peak, metric)} · {active} of {model.periods.length} {nounPlural}{" "}
          active
          {graph.focusStart === null ? ` · select a ${noun} to focus` : ""}
        </span>
      </div>
      {view === "ribbon" ? (
        <UsageRibbon {...graph} peak={peak} />
      ) : view === "heatmap" ? (
        <UsageHeatmap {...graph} peak={peak} />
      ) : (
        <UsageCumulative {...graph} />
      )}
    </div>
  );
}

/** A continuous ribbon across the section: no axes, one hairline baseline. */
function UsageRibbon({
  model,
  metric,
  resolution,
  focusStart,
  onFocus,
  reduceMotion,
  peak,
}: GraphProps & { peak: number }) {
  const grouped = resolution === "day" && model.periods.length > RIBBON_MAX_BARS ? 7 : 1;
  const periods = groupPeriods(model.periods, grouped);
  const groupPeak =
    grouped > 1 ? Math.max(...periods.map((period) => periodValue(period, metric)), 0) : peak;
  const labelEvery =
    resolution === "hour" ? 6 : periods.length > 40 ? 15 : periods.length > 14 ? 7 : 1;
  const stagger = periods.length > 0 ? Math.min(0.012, 0.35 / periods.length) : 0;

  return (
    <div className="usage-ribbon" data-empty={groupPeak <= 0 ? "true" : undefined}>
      <div
        className="usage-ribbon-bars"
        role="group"
        aria-label={`${resolution === "hour" ? "Hourly" : grouped > 1 ? "Weekly" : "Daily"} usage across the window`}
      >
        {periods.map((period, index) => {
          const total = periodValue(period, metric);
          const height = groupPeak > 0 ? (total / groupPeak) * 100 : 0;
          const tip = periodTooltip(period, metric, resolution);
          const focused = focusStart === period.startMs;
          return (
            <Tooltip key={period.startMs} label={tip.label} hint={tip.hint} placement="top">
              <motion.button
                type="button"
                className="usage-ribbon-bar"
                data-focused={focused ? "true" : undefined}
                aria-pressed={focused}
                aria-label={tip.label}
                disabled={grouped > 1}
                onClick={() => onFocus(period.startMs)}
                style={{ height: `${Math.max(total > 0 ? 2 : 0, height)}%` }}
                initial={reduceMotion ? false : { scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={
                  reduceMotion ? { duration: 0 } : { ...settleSpring, delay: index * stagger }
                }
              >
                {PROVIDER_ORDER.map((provider) => {
                  const share =
                    total > 0 ? periodValue(period.byProvider[provider], metric) / total : 0;
                  return share > 0 ? (
                    <i
                      key={provider}
                      data-provider={provider}
                      style={{ flexBasis: `${share * 100}%` }}
                    />
                  ) : null;
                })}
              </motion.button>
            </Tooltip>
          );
        })}
      </div>
      <div className="usage-ribbon-labels" aria-hidden="true">
        {periods.map((period, index) => (
          <span key={period.startMs}>
            {index % labelEvery === 0 ? formatPeriodLabel(period.startMs, resolution) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

/** Intensity step 0–4 on a square-root scale so quiet days still register. */
function heatLevel(value: number, peak: number): number {
  if (value <= 0 || peak <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(value / peak) * 4)));
}

function HeatCell({
  period,
  metric,
  resolution,
  peak,
  focusStart,
  onFocus,
}: GraphProps & { period: UsagePeriod; peak: number }) {
  const tip = periodTooltip(period, metric, resolution);
  return (
    <Tooltip label={tip.label} hint={tip.hint} placement="top">
      <button
        type="button"
        className="usage-heat-cell"
        data-level={heatLevel(periodValue(period, metric), peak)}
        data-focused={focusStart === period.startMs ? "true" : undefined}
        aria-pressed={focusStart === period.startMs}
        aria-label={tip.label}
        onClick={() => onFocus(period.startMs)}
      />
    </Tooltip>
  );
}

/** A calendar of shaded squares: weeks as columns, Monday-first. */
function UsageHeatmap(props: GraphProps & { peak: number }) {
  const { model, resolution } = props;
  if (resolution === "hour") {
    return (
      <div className="usage-heatmap usage-heatmap--hours">
        <div className="usage-heatmap-row" role="group" aria-label="Hourly usage">
          {model.periods.map((period) => (
            <HeatCell key={period.startMs} {...props} period={period} />
          ))}
        </div>
        <div className="usage-ribbon-labels" aria-hidden="true">
          {model.periods.map((period, index) => (
            <span key={period.startMs}>
              {index % 6 === 0 ? formatPeriodLabel(period.startMs, "hour") : ""}
            </span>
          ))}
        </div>
      </div>
    );
  }

  const weeks = heatmapWeeks(model.periods);
  const monthLabels = weeks.map((week, index) => {
    const month = new Date(week.startMs).getMonth();
    const previous = index > 0 ? new Date(weeks[index - 1].startMs).getMonth() : -1;
    return month !== previous
      ? new Date(week.startMs).toLocaleDateString(undefined, { month: "short" })
      : "";
  });
  return (
    <div className="usage-heatmap">
      <div className="usage-heatmap-months" aria-hidden="true">
        {weeks.map((week, index) => (
          <span key={week.startMs}>{monthLabels[index]}</span>
        ))}
      </div>
      <div className="usage-heatmap-body">
        <div className="usage-heatmap-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((label, index) => (
            <span key={index}>{label}</span>
          ))}
        </div>
        <div className="usage-heatmap-grid" role="group" aria-label="Daily usage calendar">
          {weeks.map((week) => (
            <div className="usage-heatmap-week" key={week.startMs}>
              {week.days.map((period, index) =>
                period ? (
                  <HeatCell key={period.startMs} {...props} period={period} />
                ) : (
                  <i className="usage-heat-cell usage-heat-cell--outside" key={index} />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="usage-heatmap-legend" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <i className="usage-heat-cell" data-level={level} key={level} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/** Running total across the window as one filled line; provider lines beneath. */
function UsageCumulative({ model, metric, resolution, focusStart, onFocus }: GraphProps) {
  const periods = model.periods;
  const width = Math.max(1, periods.length);
  const height = 100;
  const totals = runningTotals(periods.map((period) => periodValue(period, metric)));
  const providerRuns = PROVIDER_ORDER.map((provider) =>
    runningTotals(periods.map((period) => periodValue(period.byProvider[provider], metric))),
  );
  const max = Math.max(totals[totals.length - 1] ?? 0, 0);
  const y = (value: number) => (max > 0 ? height - (value / max) * height : height);
  const line = (values: number[]) =>
    values.map((value, index) => `${index + 0.5},${y(value).toFixed(2)}`).join(" ");
  const area = `0,${height} ${line(totals)} ${width},${height}`;
  const focusIndex = periods.findIndex((period) => period.startMs === focusStart);
  const labelEvery =
    resolution === "hour"
      ? 6
      : periods.length > 120
        ? 30
        : periods.length > 40
          ? 15
          : periods.length > 14
            ? 7
            : 1;

  return (
    <div className="usage-cumulative" data-empty={max <= 0 ? "true" : undefined}>
      <div className="usage-cumulative-axis" aria-hidden="true">
        <span>{formatMetric(max, metric)}</span>
        <span>{formatMetric(max / 2, metric)}</span>
        <span>0</span>
      </div>
      <div className="usage-cumulative-plot">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          <polygon className="usage-cumulative-area" points={area} />
          {providerRuns.map((values, index) => (
            <polyline
              key={PROVIDER_ORDER[index]}
              className="usage-cumulative-provider"
              data-provider={PROVIDER_ORDER[index]}
              points={line(values)}
            />
          ))}
          <polyline className="usage-cumulative-line" points={line(totals)} />
          {focusIndex >= 0 ? (
            <line
              className="usage-cumulative-focus"
              x1={focusIndex + 0.5}
              x2={focusIndex + 0.5}
              y1={0}
              y2={height}
            />
          ) : null}
        </svg>
        <div className="usage-cumulative-hits">
          {periods.map((period, index) => {
            const tip = periodTooltip(period, metric, resolution);
            return (
              <Tooltip
                key={period.startMs}
                label={`${tip.label} · ${formatMetric(totals[index], metric)} so far`}
                hint={tip.hint}
                placement="top"
              >
                <button
                  type="button"
                  aria-label={tip.label}
                  aria-pressed={focusStart === period.startMs}
                  onClick={() => onFocus(period.startMs)}
                />
              </Tooltip>
            );
          })}
        </div>
        <div className="usage-ribbon-labels" aria-hidden="true">
          {periods.map((period, index) => (
            <span key={period.startMs}>
              {index % labelEvery === 0 ? formatPeriodLabel(period.startMs, resolution) : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Figures line                                                               */
/* -------------------------------------------------------------------------- */

/** Totals in row-title type: this language has no hero numeral. */
function FiguresLine({
  model,
  metric,
  streaks,
  resolution,
  focusStart,
  onClearFocus,
}: {
  model: UsageDashboardModel;
  metric: UsageMetric;
  streaks: UsageStreaks;
  resolution: UsageResolution;
  focusStart: number | null;
  onClearFocus: () => void;
}) {
  const primary =
    metric === "cost"
      ? { value: formatUsd(model.costUsd), label: "at API list rate" }
      : { value: formatUsageTokens(model.totalTokens), label: "tokens processed" };
  const secondary =
    metric === "cost"
      ? { value: formatUsageTokens(model.totalTokens), label: "tokens processed" }
      : { value: formatUsd(model.costUsd), label: "at API list rate" };
  const noun = resolution === "hour" ? "hour" : "day";
  return (
    <dl className="usage-figures" data-focused={focusStart !== null ? "true" : undefined}>
      {focusStart !== null ? (
        <div className="usage-figure usage-figure--focus">
          <dt>focused {noun}</dt>
          <dd>
            <button
              type="button"
              className="usage-focus-chip"
              onClick={onClearFocus}
              aria-label={`Clear focus on ${formatPeriodLabel(focusStart, resolution)}`}
            >
              {formatPeriodLabel(focusStart, resolution)}
              <X aria-hidden="true" />
            </button>
          </dd>
        </div>
      ) : null}
      <div className="usage-figure usage-figure--lead">
        <dt>{primary.label}</dt>
        <dd>{primary.value}</dd>
      </div>
      <div className="usage-figure">
        <dt>{secondary.label}</dt>
        <dd>{secondary.value}</dd>
      </div>
      <div className="usage-figure">
        <dt>cached input</dt>
        <dd>{formatPercent(model.cachedShare)}</dd>
      </div>
      <div className="usage-figure">
        <dt>saved by cache reads</dt>
        <dd>{formatUsd(model.cacheSavingsUsd)}</dd>
      </div>
      <div className="usage-figure">
        <dt>output</dt>
        <dd>
          {formatUsageTokens(model.outputTokens)}
          <small> incl. {formatUsageTokens(model.reasoningTokens)} reasoning</small>
        </dd>
      </div>
      {focusStart === null ? (
        <div className="usage-figure">
          <dt>sessions</dt>
          <dd>{model.sessions.toLocaleString()}</dd>
        </div>
      ) : null}
      {focusStart === null && resolution === "day" ? (
        <div className="usage-figure">
          <dt>streak</dt>
          <dd>
            {streaks.current} {streaks.current === 1 ? "day" : "days"}
            <small> · longest {streaks.longest} in window</small>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* Runtime ledger                                                             */
/* -------------------------------------------------------------------------- */

interface MixSegment {
  key: string;
  label: string;
  tokens: number;
}

function mixSegments(provider: UsageProviderRollup): MixSegment[] {
  return [
    { key: "cached", label: "cached", tokens: provider.cachedInputTokens },
    { key: "uncached", label: "uncached", tokens: provider.uncachedInputTokens },
    { key: "write", label: "cache writes", tokens: provider.cacheCreationTokens },
    { key: "output", label: "output", tokens: provider.outputTokens },
  ];
}

function RuntimeLedger({
  model,
  metric,
  focused,
  openRuntimes,
  onToggle,
}: {
  model: UsageDashboardModel;
  metric: UsageMetric;
  /** Session counts are scan-wide, so they are omitted while a period is focused. */
  focused: boolean;
  openRuntimes: ReadonlySet<UsageHistoryProvider>;
  onToggle: (provider: UsageHistoryProvider) => void;
}) {
  const providers = PROVIDER_ORDER.map((provider) =>
    model.providers.find((row) => row.provider === provider),
  );
  return (
    <div className="usage-ledger">
      <div className="usage-eyebrow-row" aria-hidden="true">
        <span className="usage-eyebrow">Runtimes</span>
        <span className="usage-eyebrow usage-eyebrow--right">
          {metric === "cost" ? "Cost · tokens" : "Tokens · cost"}
        </span>
      </div>
      <ul className="usage-ledger-list">
        {providers.map((rollup, index) => {
          const provider = PROVIDER_ORDER[index];
          const source = model.sources.find((entry) => entry.provider === provider);
          const open = openRuntimes.has(provider);
          const models = model.models.filter((row) => row.provider === provider);
          const share = rollup ? (metric === "cost" ? rollup.costShare : rollup.tokenShare) : 0;
          const segments = rollup ? mixSegments(rollup) : [];
          const total = rollup?.totalTokens ?? 0;
          const unpriced = models.filter((row) => !row.priced);
          const hint = rollup
            ? `${formatPercent(share)} of ${metric === "cost" ? "cost" : "tokens"} · ${models.length} ${
                models.length === 1 ? "model" : "models"
              }${focused ? "" : ` · ${rollup.sessions.toLocaleString()} sessions`}${
                unpriced.length > 0 ? ` · ${formatUsageTokens(rollup.unpricedTokens)} unpriced` : ""
              }`
            : source?.status === "missing"
              ? `No transcripts at ${source.root}`
              : source?.status === "error"
                ? "History could not be read"
                : "No activity in this window";
          return (
            <li key={provider} className="usage-ledger-item" data-open={open ? "true" : "false"}>
              <button
                type="button"
                className="usage-ledger-row"
                aria-expanded={open}
                aria-controls={`usage-models-${provider}`}
                disabled={!rollup}
                onClick={() => onToggle(provider)}
              >
                <span className="usage-ledger-disclosure" aria-hidden="true">
                  <ChevronDown />
                </span>
                <span className="usage-ledger-identity">
                  <ProviderIcon provider={provider} label={usageProviderName(provider)} />
                  <span>
                    <strong>
                      <i className="usage-hue" data-provider={provider} aria-hidden="true" />
                      {usageProviderName(provider)}
                    </strong>
                    <small>{hint}</small>
                  </span>
                </span>
                <span className="usage-ledger-mix" data-provider={provider} aria-hidden="true">
                  <span className="usage-mix-band">
                    {segments.map((segment) =>
                      segment.tokens > 0 && total > 0 ? (
                        <i
                          key={segment.key}
                          data-segment={segment.key}
                          style={{ flexBasis: `${(segment.tokens / total) * 100}%` }}
                        />
                      ) : null,
                    )}
                  </span>
                  <small>
                    {segments
                      .filter((segment) => segment.tokens > 0 && total > 0)
                      .map((segment) => `${segment.label} ${formatPercent(segment.tokens / total)}`)
                      .join(" · ") || "—"}
                  </small>
                </span>
                <span className="usage-ledger-figures">
                  <b>
                    {rollup
                      ? metric === "cost"
                        ? formatUsd(rollup.costUsd)
                        : formatUsageTokens(rollup.totalTokens)
                      : "—"}
                  </b>
                  <small>
                    {rollup
                      ? metric === "cost"
                        ? `${formatUsageTokens(rollup.totalTokens)} tokens`
                        : formatUsd(rollup.costUsd)
                      : ""}
                  </small>
                </span>
              </button>
              <div className="usage-ledger-clip" data-open={open ? "true" : "false"}>
                <div className="usage-ledger-clip-inner" id={`usage-models-${provider}`}>
                  <ul className="usage-model-tree">
                    {models.map((row) => (
                      <li key={row.model} className="usage-model-row">
                        <span aria-hidden="true" />
                        <span className="usage-model-name">{row.model}</span>
                        <span className="usage-model-share" aria-hidden="true">
                          <i
                            data-provider={provider}
                            style={{
                              width: `${Math.max(
                                row.totalTokens > 0 ? 1.5 : 0,
                                (metric === "cost"
                                  ? rollup && rollup.costUsd > 0
                                    ? row.costUsd / rollup.costUsd
                                    : 0
                                  : total > 0
                                    ? row.totalTokens / total
                                    : 0) * 100,
                              )}%`,
                            }}
                          />
                        </span>
                        <span className="usage-model-figures">
                          <b data-unpriced={row.priced ? undefined : "true"}>
                            {metric === "cost"
                              ? row.priced
                                ? formatUsd(row.costUsd)
                                : "no list price"
                              : formatUsageTokens(row.totalTokens)}
                          </b>
                          <small>
                            {metric === "cost"
                              ? `${formatUsageTokens(row.totalTokens)} tokens`
                              : row.priced
                                ? formatUsd(row.costUsd)
                                : "no list price"}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Coverage note and skeleton                                                 */
/* -------------------------------------------------------------------------- */

function UsageCoverage({ model }: { model: UsageDashboardModel }) {
  const scanned = model.sources.filter((source) => source.status === "scanned");
  const files = scanned.reduce((sum, source) => sum + source.filesScanned, 0);
  return (
    <p className="settings-measured-note usage-coverage">
      Measured {new Date(model.measuredAt).toLocaleString()}
      {scanned.length > 0 ? ` · ${files.toLocaleString()} transcript files scanned` : ""}
      {model.unpricedTokens > 0
        ? ` · ${formatUsageTokens(model.unpricedTokens)} tokens ran on models with no published list price and are left out of cost`
        : ""}
      . Cost is what these tokens would list for on each vendor's public API — cache reads at a
      tenth of input, Anthropic cache writes by TTL — not your subscription bill.
    </p>
  );
}

/** Static stand-in with the loaded layout's shape, so nothing jumps when data lands. */
function UsageSkeleton() {
  return (
    <div className="usage-skeleton" aria-hidden="true">
      <div className="usage-graph">
        <div className="usage-graph-caption">
          <span className="usage-graph-note">Scanning local history</span>
        </div>
        <div className="usage-ribbon-bars">
          {SKELETON_RIBBON.map((height, index) => (
            <div
              className="usage-ribbon-bar usage-skeleton-block"
              key={index}
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      </div>
      <dl className="usage-figures">
        {["at API list rate", "tokens processed", "cached input", "sessions"].map((label) => (
          <div className="usage-figure" key={label}>
            <dt>{label}</dt>
            <dd>
              <i className="usage-skeleton-block" style={{ width: "5ch", height: 14 }} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="usage-ledger">
        <div className="usage-eyebrow-row">
          <span className="usage-eyebrow">Runtimes</span>
        </div>
        <ul className="usage-ledger-list">
          {PROVIDER_ORDER.map((provider) => (
            <li key={provider} className="usage-ledger-item">
              <div className="usage-ledger-row">
                <span className="usage-ledger-disclosure">
                  <ChevronDown />
                </span>
                <span className="usage-ledger-identity">
                  <ProviderIcon provider={provider} label={usageProviderName(provider)} />
                  <span>
                    <strong>{usageProviderName(provider)}</strong>
                    <i className="usage-skeleton-block" style={{ width: "16ch", height: 9 }} />
                  </span>
                </span>
                <span className="usage-ledger-mix">
                  <span className="usage-mix-band usage-skeleton-block" />
                </span>
                <span className="usage-ledger-figures">
                  <i className="usage-skeleton-block" style={{ width: "6ch", height: 12 }} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
