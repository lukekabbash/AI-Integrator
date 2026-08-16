import { describe, expect, it } from "vitest";

import {
  aggregateUsageHistory,
  EMPTY_TOTALS,
  computeStreaks,
  createDemoUsageHistoryReport,
  enumeratePeriods,
  groupPeriods,
  heatmapWeeks,
  periodWindow,
  formatPercent,
  formatUsageTokens,
  formatUsd,
  makeUsageWindow,
  normalizeModelName,
  periodStart,
  priceTotals,
  rateForModel,
  totalTokens,
  type UsageHistoryReport,
  type UsageHistorySlice,
} from "./usageHistory";

const HOUR = 3_600_000;
const NOW = new Date(2026, 7, 16, 14, 30, 0).getTime();

function slice(overrides: Partial<UsageHistorySlice>): UsageHistorySlice {
  return {
    provider: "codex",
    model: "gpt-5.6-sol",
    hourStartMs: Math.floor(NOW / HOUR) * HOUR,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreationLongTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: null,
    ...overrides,
  };
}

function report(slices: UsageHistorySlice[]): UsageHistoryReport {
  return {
    sinceMs: NOW - 90 * 24 * HOUR,
    untilMs: NOW,
    measuredAt: new Date(NOW).toISOString(),
    slices,
    sources: [
      {
        provider: "codex",
        root: "~/.codex/sessions",
        status: "scanned",
        filesScanned: 3,
        filesSkipped: 1,
        sessions: 2,
      },
      {
        provider: "claude",
        root: "~/.claude/projects",
        status: "missing",
        filesScanned: 0,
        filesSkipped: 0,
        sessions: 0,
      },
    ],
  };
}

describe("usage windows", () => {
  it("builds an hourly 24h window ending on the next hour boundary", () => {
    const window = makeUsageWindow(1, NOW);
    expect(window.resolution).toBe("hour");
    expect(window.untilMs % HOUR).toBe(0);
    expect(window.untilMs - window.sinceMs).toBe(24 * HOUR);
    expect(enumeratePeriods(window)).toHaveLength(24);
  });

  it("builds a daily window starting on a local midnight and enumerates every day", () => {
    const window = makeUsageWindow(7, NOW);
    expect(window.resolution).toBe("day");
    expect(new Date(window.sinceMs).getHours()).toBe(0);
    expect(enumeratePeriods(window)).toHaveLength(7);
    expect(periodStart(NOW, "day")).toBe(new Date(2026, 7, 16).getTime());
  });
});

describe("pricing", () => {
  it("normalises vendor prefixes and dated snapshots, then matches exactly", () => {
    expect(normalizeModelName("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(rateForModel("claude-haiku-4-5-20251001")?.output).toBe(5);
    expect(rateForModel("gpt-5.6-sol")?.output).toBe(30);
    expect(rateForModel("gpt-5.4-mini")?.input).toBe(0.75);
    // Near-misses must not inherit a similar model's price.
    expect(rateForModel("gpt-5.3-codex-spark")).toBeNull();
    expect(rateForModel("gpt-daybreak-blue-latest")).toBeNull();
    expect(rateForModel("claude-opus-9")).toBeNull();
  });

  it("prices Anthropic cache writes by TTL and reads at a tenth of input", () => {
    const priced = priceTotals("claude-fable-5", {
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheCreationLongTokens: 400_000,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
    });
    // 10 input + 1 read + (0.6M @ 12.50 + 0.4M @ 20) + 50 output
    expect(priced.costUsd).toBeCloseTo(10 + 1 + 7.5 + 8 + 50, 6);
    expect(priced.cacheSavingsUsd).toBeCloseTo(9, 6);
  });

  it("charges no cache-write premium on OpenAI models", () => {
    const priced = priceTotals("gpt-5.6-sol", {
      ...EMPTY_TOTALS,
      cacheCreationTokens: 1_000_000,
      cacheCreationLongTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    });
    // A write is ordinary input ($5); a read is a tenth ($0.50).
    expect(priced.costUsd).toBeCloseTo(5 + 0.5, 6);
  });

  it("applies dated introductory pricing to the slice's own timestamp", () => {
    const intro = Date.parse("2026-08-01T00:00:00Z");
    const after = Date.parse("2026-09-15T00:00:00Z");
    expect(rateForModel("claude-sonnet-5", intro)?.input).toBe(2);
    expect(rateForModel("claude-sonnet-5", after)?.input).toBe(3);
    expect(rateForModel("claude-sonnet-5")?.input).toBe(3);
  });
});

describe("aggregateUsageHistory", () => {
  it("rolls slices into totals, providers, models and periods within the window only", () => {
    const window = makeUsageWindow(7, NOW);
    const inWindow = slice({
      uncachedInputTokens: 1000,
      cachedInputTokens: 4000,
      outputTokens: 500,
      reasoningTokens: 100,
    });
    const claude = slice({
      provider: "claude",
      model: "claude-sonnet-5",
      hourStartMs: inWindow.hourStartMs - 26 * HOUR,
      uncachedInputTokens: 2000,
      outputTokens: 1000,
      reportedCostUsd: 0.25,
    });
    const outOfWindow = slice({ hourStartMs: window.sinceMs - HOUR, outputTokens: 999_999 });
    const model = aggregateUsageHistory(report([inWindow, claude, outOfWindow]), window);

    expect(model.totalTokens).toBe(totalTokens(inWindow) + totalTokens(claude));
    expect(model.reasoningTokens).toBe(100);
    expect(model.providers.map((p) => p.provider).sort()).toEqual(["claude", "codex"]);
    expect(model.providers.find((p) => p.provider === "codex")?.sessions).toBe(2);
    expect(model.models).toHaveLength(2);
    expect(model.periods).toHaveLength(7);
    expect(model.periods.filter((p) => p.totalTokens > 0)).toHaveLength(2);
    expect(model.activePeriods).toBe(2);
    // Vendor-reported cost wins over the bundled rate.
    expect(model.models.find((m) => m.provider === "claude")?.costUsd).toBeCloseTo(0.25, 6);
    expect(model.cachedShare).toBeCloseTo(4000 / 7000, 6);
    expect(model.unpricedTokens).toBe(0);
  });

  it("keeps unpriced models in token totals and flags them", () => {
    const window = makeUsageWindow(30, NOW);
    const model = aggregateUsageHistory(
      report([slice({ model: "gpt-daybreak-blue-latest", outputTokens: 4200 })]),
      window,
    );
    expect(model.totalTokens).toBe(4200);
    expect(model.costUsd).toBe(0);
    expect(model.unpricedTokens).toBe(4200);
    expect(model.models[0]?.priced).toBe(false);
  });

  it("produces a populated demo report", () => {
    const model = aggregateUsageHistory(
      createDemoUsageHistoryReport(NOW),
      makeUsageWindow(30, NOW),
    );
    expect(model.totalTokens).toBeGreaterThan(0);
    expect(model.providers).toHaveLength(2);
    expect(model.periods).toHaveLength(30);
  });
});

describe("formatting", () => {
  it("formats tokens, dollars and percentages compactly", () => {
    expect(formatUsageTokens(950)).toBe("950");
    expect(formatUsageTokens(12_400)).toBe("12K");
    expect(formatUsageTokens(1_260_000)).toBe("1.3M");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatPercent(0.0512)).toBe("5.1%");
    expect(formatPercent(0.4)).toBe("40%");
  });
});

describe("graph helpers", () => {
  const day = (offset: number, tokens: number) => {
    const start = new Date(2026, 7, 1 + offset).getTime();
    return {
      startMs: start,
      totalTokens: tokens,
      costUsd: tokens / 1000,
      byProvider: tokens > 0 ? { codex: { totalTokens: tokens, costUsd: tokens / 1000 } } : {},
    };
  };

  it("counts streaks, tolerating a quiet final day", () => {
    const active = [1, 1, 0, 1, 1, 1, 0].map((on, index) => day(index, on ? 100 : 0));
    expect(computeStreaks(active)).toEqual({ current: 3, longest: 3 });
    expect(computeStreaks([day(0, 0), day(1, 0)])).toEqual({ current: 0, longest: 0 });
    expect(computeStreaks([day(0, 5), day(1, 5)])).toEqual({ current: 2, longest: 2 });
  });

  it("groups periods and keeps provider buckets summed", () => {
    const grouped = groupPeriods([day(0, 10), day(1, 20), day(2, 30)], 2);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].totalTokens).toBe(30);
    expect(grouped[0].byProvider.codex?.totalTokens).toBe(30);
    expect(grouped[1].totalTokens).toBe(30);
  });

  it("lays days out Monday-first with padding outside the window", () => {
    // 2026-08-01 is a Saturday.
    const weeks = heatmapWeeks([day(0, 1), day(1, 2), day(2, 3)]);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].days.slice(0, 5).every((cell) => cell === null)).toBe(true);
    expect(weeks[0].days[5]?.totalTokens).toBe(1);
    expect(weeks[1].days[0]?.totalTokens).toBe(3);
  });

  it("builds a single-period window for focus", () => {
    const window = makeUsageWindow(7, NOW);
    const start = new Date(2026, 7, 12).getTime();
    const focused = periodWindow(window, start);
    expect(focused.sinceMs).toBe(start);
    expect(new Date(focused.untilMs).getDate()).toBe(13);
    const hourly = periodWindow(makeUsageWindow(1, NOW), start);
    expect(hourly.untilMs - hourly.sinceMs).toBe(HOUR);
  });
});
