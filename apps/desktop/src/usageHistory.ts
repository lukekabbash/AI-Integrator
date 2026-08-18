/**
 * Usage history: what the installed vendor CLIs recorded on this machine.
 *
 * The native side scans each runtime's own local transcripts (Codex rollouts,
 * Claude Code project logs) and returns hourly slices per provider and model.
 * Everything here is pure: windowing, day/hour bucketing in the viewer's time
 * zone, API-rate pricing, and formatting. The dashboard renders this model.
 */

export type UsageHistoryProvider = "codex" | "claude";

export interface UsageTokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  /** Subset of cacheCreationTokens written with a 1-hour TTL; priced higher. */
  cacheCreationLongTokens: number;
  outputTokens: number;
  /** Subset of outputTokens; never added to the total again. */
  reasoningTokens: number;
}

export interface UsageHistorySlice extends UsageTokenTotals {
  provider: UsageHistoryProvider;
  model: string;
  /** Start of the UTC hour this slice belongs to (epoch ms). */
  hourStartMs: number;
  /** Cost the vendor wrote into its own log, when it did. */
  reportedCostUsd: number | null;
}

export interface UsageHistorySource {
  provider: UsageHistoryProvider;
  /** Home-relative root that was scanned, for the coverage note. */
  root: string;
  status: "scanned" | "missing" | "error";
  filesScanned: number;
  filesSkipped: number;
  sessions: number;
  detail?: string;
}

export interface UsageHistoryReport {
  sinceMs: number;
  untilMs: number;
  measuredAt: string;
  slices: UsageHistorySlice[];
  sources: UsageHistorySource[];
}

export type UsageWindowDays = 1 | 7 | 30 | 90 | 365 | "all";
export type UsageResolution = "hour" | "day";
export type UsageMetric = "cost" | "tokens";

export interface UsageWindow {
  days: UsageWindowDays;
  resolution: UsageResolution;
  sinceMs: number;
  untilMs: number;
}

export const USAGE_WINDOW_OPTIONS: ReadonlyArray<{ days: UsageWindowDays; label: string }> = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "1y" },
  { days: "all", label: "All" },
];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ALL_USAGE_START_YEAR = 2024;

/** A window ends now and starts on a local day boundary (or an hour boundary for 24h). */
export function makeUsageWindow(days: UsageWindowDays, now = Date.now()): UsageWindow {
  if (days === "all") {
    return {
      days,
      resolution: "day",
      sinceMs: new Date(ALL_USAGE_START_YEAR, 0, 1).getTime(),
      untilMs: now,
    };
  }
  if (days === 1) {
    const untilMs = Math.ceil(now / HOUR_MS) * HOUR_MS;
    return { days, resolution: "hour", sinceMs: untilMs - DAY_MS, untilMs };
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const sinceMs = start.getTime() - (days - 1) * DAY_MS;
  return { days, resolution: "day", sinceMs, untilMs: now };
}

/* -------------------------------------------------------------------------- */
/* Pricing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * USD per million tokens, by token class.
 *
 * Cache economics differ by vendor and are not a detail: on a Claude Code
 * workload cache reads are ~97% of all tokens. Anthropic charges a premium to
 * *write* the cache (1.25x input for the 5-minute TTL, 2x for the 1-hour one)
 * and 0.1x to read it. OpenAI does not charge a write premium — a cache write
 * is ordinary input — and also reads at 0.1x.
 */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  /** Short-lived (5-minute) cache write. */
  cacheWrite: number;
  /** 1-hour cache write, where the vendor prices it separately. */
  cacheWriteLong: number;
}

/** Where a rate came from, so the UI never implies more precision than we have. */
export type RateSource = "anthropic" | "openai";

export interface ModelPricing {
  source: RateSource;
  rate: ModelRate;
  /** Promotional rate in force up to (and including) this instant. */
  intro?: { untilMs: number; rate: ModelRate };
}

function anthropicRate(input: number, output: number): ModelRate {
  return {
    input,
    output,
    cacheRead: input * 0.1,
    cacheWrite: input * 1.25,
    cacheWriteLong: input * 2,
  };
}

function openAiRate(input: number, output: number): ModelRate {
  // No write premium: a cache write is billed as ordinary input.
  return { input, output, cacheRead: input * 0.1, cacheWrite: input, cacheWriteLong: input };
}

/** Claude Sonnet 5 introductory pricing runs through 2026-08-31. */
const SONNET_5_INTRO_UNTIL = Date.parse("2026-09-01T00:00:00Z");

/**
 * Published list prices, keyed by exact normalised model id.
 *
 * Deliberately exact: an unrecognised model is reported as unpriced rather
 * than matched to a similarly-named one. Prefix matching silently priced
 * `gpt-5.6-sol` as `gpt-5` and every `claude-*-5` as unpriced.
 *
 * Anthropic rates are the first-party API rates; OpenAI rates are the public
 * standard-tier rates. Long-context (>272K) tiers are not applied — the
 * transcripts do not record which tier served a request.
 */
export const MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map([
  ["claude-fable-5", { source: "anthropic", rate: anthropicRate(10, 50) }],
  ["claude-mythos-5", { source: "anthropic", rate: anthropicRate(10, 50) }],
  ["claude-opus-5", { source: "anthropic", rate: anthropicRate(5, 25) }],
  ["claude-opus-4-8", { source: "anthropic", rate: anthropicRate(5, 25) }],
  ["claude-opus-4-7", { source: "anthropic", rate: anthropicRate(5, 25) }],
  ["claude-opus-4-6", { source: "anthropic", rate: anthropicRate(5, 25) }],
  [
    "claude-sonnet-5",
    {
      source: "anthropic",
      rate: anthropicRate(3, 15),
      intro: { untilMs: SONNET_5_INTRO_UNTIL, rate: anthropicRate(2, 10) },
    },
  ],
  ["claude-sonnet-4-6", { source: "anthropic", rate: anthropicRate(3, 15) }],
  ["claude-haiku-4-5", { source: "anthropic", rate: anthropicRate(1, 5) }],
  ["gpt-5.6-sol", { source: "openai", rate: openAiRate(5, 30) }],
  ["gpt-5.6-terra", { source: "openai", rate: openAiRate(2, 12) }],
  ["gpt-5.6-luna", { source: "openai", rate: openAiRate(0.2, 1.2) }],
  ["gpt-5.5", { source: "openai", rate: openAiRate(5, 30) }],
  ["gpt-5.5-pro", { source: "openai", rate: openAiRate(30, 180) }],
  ["gpt-5.4", { source: "openai", rate: openAiRate(2.5, 15) }],
  ["gpt-5.4-mini", { source: "openai", rate: openAiRate(0.75, 4.5) }],
  ["gpt-5.4-nano", { source: "openai", rate: openAiRate(0.2, 1.25) }],
  ["gpt-5.3-codex", { source: "openai", rate: openAiRate(1.75, 14) }],
]);

/** Strips a vendor prefix and a dated snapshot suffix; nothing else. */
export function normalizeModelName(model: string): string {
  let name = model.trim().toLowerCase();
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  return name.replace(/[-@]20\d{6}$/, "");
}

export function rateForModel(model: string, atMs?: number): ModelRate | null {
  const pricing = MODEL_PRICING.get(normalizeModelName(model));
  if (!pricing) return null;
  if (pricing.intro && atMs !== undefined && atMs < pricing.intro.untilMs)
    return pricing.intro.rate;
  return pricing.rate;
}

export interface PricedTotals {
  costUsd: number;
  /** What the cache reads would have cost at the uncached input rate, minus what they did. */
  cacheSavingsUsd: number;
  priced: boolean;
}

export function priceTotals(model: string, totals: UsageTokenTotals, atMs?: number): PricedTotals {
  const rate = rateForModel(model, atMs);
  if (!rate) return { costUsd: 0, cacheSavingsUsd: 0, priced: false };
  const perToken = 1 / 1_000_000;
  const longWrite = Math.min(totals.cacheCreationLongTokens, totals.cacheCreationTokens);
  const shortWrite = totals.cacheCreationTokens - longWrite;
  const costUsd =
    (totals.uncachedInputTokens * rate.input +
      totals.cachedInputTokens * rate.cacheRead +
      shortWrite * rate.cacheWrite +
      longWrite * rate.cacheWriteLong +
      totals.outputTokens * rate.output) *
    perToken;
  const cacheSavingsUsd = Math.max(
    0,
    totals.cachedInputTokens * (rate.input - rate.cacheRead) * perToken,
  );
  return { costUsd, cacheSavingsUsd, priced: true };
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

export interface UsageProviderRollup extends UsageTokenTotals {
  provider: UsageHistoryProvider;
  totalTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  costShare: number;
  tokenShare: number;
  sessions: number;
  unpricedTokens: number;
}

export interface UsagePeriod {
  startMs: number;
  totalTokens: number;
  costUsd: number;
  byProvider: Partial<Record<UsageHistoryProvider, { totalTokens: number; costUsd: number }>>;
}

export interface UsageModelRollup extends UsageTokenTotals {
  provider: UsageHistoryProvider;
  model: string;
  totalTokens: number;
  costUsd: number;
  costShare: number;
  priced: boolean;
}

export interface UsageDashboardModel extends UsageTokenTotals {
  window: UsageWindow;
  totalTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  cachedShare: number;
  sessions: number;
  activePeriods: number;
  periodAverageTokens: number;
  providers: UsageProviderRollup[];
  periods: UsagePeriod[];
  models: UsageModelRollup[];
  sources: UsageHistorySource[];
  unpricedTokens: number;
  measuredAt: string;
}

export const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  cacheCreationLongTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheCreationLongTokens: a.cacheCreationLongTokens + b.cacheCreationLongTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/** Start of the local day (or the hour, for hourly windows) that contains `ms`. */
export function periodStart(ms: number, resolution: UsageResolution): number {
  if (resolution === "hour") return Math.floor(ms / HOUR_MS) * HOUR_MS;
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Every period start covering the window, so quiet days still get a bar. */
export function enumeratePeriods(window: UsageWindow): number[] {
  const starts: number[] = [];
  if (window.resolution === "hour") {
    for (let t = periodStart(window.sinceMs, "hour"); t < window.untilMs; t += HOUR_MS)
      starts.push(t);
    return starts;
  }
  const cursor = new Date(periodStart(window.sinceMs, "day"));
  while (cursor.getTime() <= window.untilMs) {
    starts.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return starts;
}

export function aggregateUsageHistory(
  report: UsageHistoryReport,
  window: UsageWindow,
): UsageDashboardModel {
  const providerMap = new Map<UsageHistoryProvider, UsageProviderRollup>();
  const modelMap = new Map<string, UsageModelRollup>();
  const periodMap = new Map<number, UsagePeriod>();
  for (const start of enumeratePeriods(window)) {
    periodMap.set(start, { startMs: start, totalTokens: 0, costUsd: 0, byProvider: {} });
  }

  let totals: UsageTokenTotals = EMPTY_TOTALS;
  let costUsd = 0;
  let cacheSavingsUsd = 0;
  let unpricedTokens = 0;

  for (const slice of report.slices) {
    if (slice.hourStartMs < window.sinceMs || slice.hourStartMs >= window.untilMs) continue;
    const priced = priceTotals(slice.model, slice, slice.hourStartMs);
    const sliceTokens = totalTokens(slice);
    const sliceCost = slice.reportedCostUsd ?? priced.costUsd;
    totals = addTotals(totals, slice);
    costUsd += sliceCost;
    cacheSavingsUsd += priced.cacheSavingsUsd;
    if (!priced.priced && slice.reportedCostUsd == null) unpricedTokens += sliceTokens;

    const provider =
      providerMap.get(slice.provider) ??
      ({
        ...EMPTY_TOTALS,
        provider: slice.provider,
        totalTokens: 0,
        costUsd: 0,
        cacheSavingsUsd: 0,
        costShare: 0,
        tokenShare: 0,
        sessions: 0,
        unpricedTokens: 0,
      } satisfies UsageProviderRollup);
    Object.assign(provider, addTotals(provider, slice));
    provider.totalTokens += sliceTokens;
    provider.costUsd += sliceCost;
    provider.cacheSavingsUsd += priced.cacheSavingsUsd;
    if (!priced.priced && slice.reportedCostUsd == null) provider.unpricedTokens += sliceTokens;
    providerMap.set(slice.provider, provider);

    const modelKey = `${slice.provider}:${slice.model}`;
    const model =
      modelMap.get(modelKey) ??
      ({
        ...EMPTY_TOTALS,
        provider: slice.provider,
        model: slice.model,
        totalTokens: 0,
        costUsd: 0,
        costShare: 0,
        priced: priced.priced || slice.reportedCostUsd != null,
      } satisfies UsageModelRollup);
    Object.assign(model, addTotals(model, slice));
    model.totalTokens += sliceTokens;
    model.costUsd += sliceCost;
    model.priced = model.priced || priced.priced || slice.reportedCostUsd != null;
    modelMap.set(modelKey, model);

    const start = periodStart(slice.hourStartMs, window.resolution);
    const period = periodMap.get(start) ?? {
      startMs: start,
      totalTokens: 0,
      costUsd: 0,
      byProvider: {},
    };
    period.totalTokens += sliceTokens;
    period.costUsd += sliceCost;
    const bucket = period.byProvider[slice.provider] ?? { totalTokens: 0, costUsd: 0 };
    bucket.totalTokens += sliceTokens;
    bucket.costUsd += sliceCost;
    period.byProvider[slice.provider] = bucket;
    periodMap.set(start, period);
  }

  for (const source of report.sources) {
    const provider = providerMap.get(source.provider);
    if (provider) provider.sessions += source.sessions;
  }

  const total = totalTokens(totals);
  const providers = [...providerMap.values()]
    .map((provider) => ({
      ...provider,
      costShare: costUsd > 0 ? provider.costUsd / costUsd : 0,
      tokenShare: total > 0 ? provider.totalTokens / total : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  const models = [...modelMap.values()]
    .map((model) => ({ ...model, costShare: costUsd > 0 ? model.costUsd / costUsd : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  const periods = [...periodMap.values()].sort((a, b) => a.startMs - b.startMs);
  const activePeriods = periods.filter((period) => period.totalTokens > 0).length;
  const observedInput = totals.uncachedInputTokens + totals.cachedInputTokens;

  return {
    ...totals,
    window,
    totalTokens: total,
    costUsd,
    cacheSavingsUsd,
    cachedShare: observedInput > 0 ? totals.cachedInputTokens / observedInput : 0,
    sessions: providers.reduce((sum, provider) => sum + provider.sessions, 0),
    activePeriods,
    periodAverageTokens: activePeriods > 0 ? total / activePeriods : 0,
    providers,
    periods,
    models,
    sources: report.sources,
    unpricedTokens,
    measuredAt: report.measuredAt,
  };
}

/** A window covering exactly one period, for focusing the figures on a day or hour. */
export function periodWindow(window: UsageWindow, startMs: number): UsageWindow {
  const untilMs =
    window.resolution === "hour"
      ? startMs + HOUR_MS
      : (() => {
          const next = new Date(startMs);
          next.setDate(next.getDate() + 1);
          return next.getTime();
        })();
  return { ...window, sinceMs: startMs, untilMs };
}

export interface UsageStreaks {
  current: number;
  longest: number;
}

/**
 * Consecutive active periods. The current streak tolerates an inactive final
 * period (today has not necessarily happened yet), like the vendors' own pages.
 */
export function computeStreaks(periods: UsagePeriod[]): UsageStreaks {
  let longest = 0;
  let run = 0;
  for (const period of periods) {
    run = period.totalTokens > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  let current = 0;
  let index = periods.length - 1;
  if (index >= 0 && periods[index].totalTokens === 0) index -= 1;
  while (index >= 0 && periods[index].totalTokens > 0) {
    current += 1;
    index -= 1;
  }
  return { current, longest };
}

/** Folds consecutive periods into groups of `size` (first start wins). */
export function groupPeriods(periods: UsagePeriod[], size: number): UsagePeriod[] {
  if (size <= 1) return periods;
  const groups: UsagePeriod[] = [];
  for (let index = 0; index < periods.length; index += size) {
    const chunk = periods.slice(index, index + size);
    const group: UsagePeriod = {
      startMs: chunk[0].startMs,
      totalTokens: 0,
      costUsd: 0,
      byProvider: {},
    };
    for (const period of chunk) {
      group.totalTokens += period.totalTokens;
      group.costUsd += period.costUsd;
      for (const [provider, bucket] of Object.entries(period.byProvider) as Array<
        [UsageHistoryProvider, { totalTokens: number; costUsd: number }]
      >) {
        const target = group.byProvider[provider] ?? { totalTokens: 0, costUsd: 0 };
        target.totalTokens += bucket.totalTokens;
        target.costUsd += bucket.costUsd;
        group.byProvider[provider] = target;
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Calendar rows for a heatmap: weeks as columns, Monday-first days as rows. */
export interface HeatmapWeek {
  /** Monday of the week (epoch ms). */
  startMs: number;
  /** Seven cells, Monday..Sunday; null outside the window. */
  days: Array<UsagePeriod | null>;
}

export function heatmapWeeks(periods: UsagePeriod[]): HeatmapWeek[] {
  if (periods.length === 0) return [];
  const byStart = new Map(periods.map((period) => [period.startMs, period]));
  const first = new Date(periods[0].startMs);
  const mondayOffset = (first.getDay() + 6) % 7;
  const cursor = new Date(first);
  cursor.setDate(cursor.getDate() - mondayOffset);
  const last = periods[periods.length - 1].startMs;
  const weeks: HeatmapWeek[] = [];
  while (cursor.getTime() <= last) {
    const week: HeatmapWeek = { startMs: cursor.getTime(), days: [] };
    for (let day = 0; day < 7; day += 1) {
      week.days.push(byStart.get(cursor.getTime()) ?? null);
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

export function formatUsageTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000)
    return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value >= 1000) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  const percent = value * 100;
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

export function formatPeriodLabel(startMs: number, resolution: UsageResolution): string {
  const date = new Date(startMs);
  if (resolution === "hour") {
    return date.toLocaleTimeString(undefined, { hour: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatWindowRange(window: UsageWindow): string {
  const since = new Date(window.sinceMs);
  const until = new Date(window.untilMs);
  if (window.resolution === "hour") {
    const time = (d: Date) =>
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${time(since)} yesterday to now`;
  }
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day(since)} to ${day(until)}`;
}

export function usageProviderName(provider: UsageHistoryProvider): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

/* -------------------------------------------------------------------------- */
/* Demo (browser preview without a native core)                               */
/* -------------------------------------------------------------------------- */

/** Deterministic pseudo-history so the browser build shows a populated dashboard. */
export function createDemoUsageHistoryReport(now = Date.now()): UsageHistoryReport {
  let seed = 7;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const slices: UsageHistorySlice[] = [];
  const models: Array<[UsageHistoryProvider, string, number]> = [
    ["codex", "gpt-5.6-sol", 1.4],
    ["codex", "gpt-5.4-mini", 0.5],
    ["claude", "claude-fable-5", 0.7],
    ["claude", "claude-sonnet-5", 1],
  ];
  const untilHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  for (let hoursAgo = 0; hoursAgo < 90 * 24; hoursAgo += 1) {
    const hourStartMs = untilHour - hoursAgo * HOUR_MS;
    const localHour = new Date(hourStartMs).getHours();
    const awake = localHour >= 8 && localHour <= 23;
    const weekday = new Date(hourStartMs).getDay();
    const busy = weekday === 0 || weekday === 6 ? 0.45 : 1;
    for (const [provider, model, weight] of models) {
      if (!awake || random() > 0.42 * busy) continue;
      const scale = weight * busy * (0.4 + random() * 1.6) * (hoursAgo < 24 * 14 ? 1.5 : 1);
      const uncachedInputTokens = Math.round(9_000 * scale * random());
      const cachedInputTokens = Math.round(48_000 * scale * random());
      const outputTokens = Math.round(3_200 * scale * random());
      slices.push({
        provider,
        model,
        hourStartMs,
        uncachedInputTokens,
        cachedInputTokens,
        cacheCreationTokens: provider === "claude" ? Math.round(2_400 * scale * random()) : 0,
        cacheCreationLongTokens: provider === "claude" ? Math.round(1_600 * scale * random()) : 0,
        outputTokens,
        reasoningTokens: Math.round(outputTokens * 0.35),
        reportedCostUsd: null,
      });
    }
  }
  return {
    sinceMs: untilHour - 90 * DAY_MS,
    untilMs: now,
    measuredAt: new Date(now).toISOString(),
    slices,
    sources: [
      {
        provider: "codex",
        root: "~/.codex/sessions",
        status: "scanned",
        filesScanned: 212,
        filesSkipped: 640,
        sessions: 118,
      },
      {
        provider: "claude",
        root: "~/.claude/projects",
        status: "scanned",
        filesScanned: 96,
        filesSkipped: 310,
        sessions: 74,
      },
    ],
  };
}
