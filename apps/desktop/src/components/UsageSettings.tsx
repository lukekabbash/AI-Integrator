import { CircleDollarSign, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  bridge,
  type ProviderUsageSummary,
  type RuntimeActionPlan,
  type RuntimeConnection,
  type SubscriptionQuota,
  type SubscriptionQuotaBucket,
  type SubscriptionWindow,
  type UsageSnapshot,
  type UsageSummary,
} from "../bridge";
import { ProviderIcon } from "./Dropdown";
import { RuntimeSetupTerminal } from "./RuntimeSetupTerminal";
import { Tooltip } from "./Tooltip";
import { UsageDashboard } from "./UsageDashboard";

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function providerUsageLabel(provider: ProviderUsageSummary["provider"]): string {
  if (provider === "unknown") return "Unknown runtime";
  return provider === "custom" ? "Custom runtime" : provider[0].toUpperCase() + provider.slice(1);
}

function formatEstimatedCost(usd: number): string {
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

/** Labels a rate-limit window by its provider-reported duration; the labels
 * are derived, never assumed (Codex documents primary/secondary only via
 * windowDurationMins). */
function quotaWindowLabel(mins?: number): string {
  if (!mins) return "window";
  if (Math.abs(mins - 300) <= 15) return "5h";
  if (Math.abs(mins - 1440) <= 72) return "daily";
  if (Math.abs(mins - 10080) <= 504) return "weekly";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function usageProvenanceLabel(provenance: ProviderUsageSummary["provenance"]): string {
  return {
    vendor_exact: "Vendor exact",
    local_observed: "Local observed",
    estimated: "Estimated",
    unavailable: "Unavailable",
  }[provenance];
}

function subscriptionBuckets(quota?: SubscriptionQuota): SubscriptionQuotaBucket[] {
  if (!quota) return [];
  const buckets = (quota.buckets ?? []).filter((bucket) => bucket.primary || bucket.secondary);
  if (buckets.length > 0) return buckets;
  if (!quota.primary && !quota.secondary) return [];
  return [
    {
      limitId: "default",
      planType: quota.planType,
      primary: quota.primary,
      secondary: quota.secondary,
    },
  ];
}

function quotaResetLabel(resetsAt?: number): string {
  if (!resetsAt) return "Reset time unavailable";
  const distance = resetsAt * 1_000 - Date.now();
  if (distance <= 0) return "Reset pending";
  const hours = Math.ceil(distance / 3_600_000);
  if (hours < 24) return `Resets in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return `Resets in ${days}d${remainder ? ` ${remainder}h` : ""}`;
}

function runtimeUsageGuidance(runtime: RuntimeConnection): {
  label: string;
  detail: string;
  action: string;
} {
  if (runtime.id === "claude")
    return {
      label: "Session and weekly limits",
      detail: "Claude’s own /usage screen reports session, weekly, model, and credit limits.",
      action: "Open /usage",
    };
  if (runtime.id === "grok")
    return {
      label: "Weekly limit and reset",
      detail: "Grok’s own /usage screen reports its current weekly limit and reset time.",
      action: "Open /usage",
    };
  if (runtime.id === "kimi")
    return {
      label: "Quota and context",
      detail: "Kimi’s own /usage screen is the authority for account quota and context.",
      action: "Open /usage",
    };
  if (runtime.id === "antigravity")
    return {
      label: "Per-model limits",
      detail: "Antigravity exposes provider-owned limits through /usage or /quota after sign-in.",
      action: "Open usage",
    };
  if (runtime.id === "cursor")
    return {
      label: "Activity and context",
      detail:
        "Cursor’s /usage is coding activity, not plan headroom; /context explains this session.",
      action: "Open activity",
    };
  return {
    label: "Session usage only",
    detail: "This runtime has not exposed a safe account-quota query to Integrator.",
    action: "Open runtime",
  };
}

const loadUsageHistory = (sinceMs: number, untilMs: number) =>
  bridge.getUsageHistory(sinceMs, untilMs);

/** Usage and Budgets: local CLI history on top, live plan headroom and the
 * per-runtime usage terminals below, then Integrator's own recorded usage. */
export function UsageSettings({
  usage,
  runtimes,
}: {
  usage: UsageSnapshot;
  runtimes: RuntimeConnection[];
}) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [usagePlan, setUsagePlan] = useState<RuntimeActionPlan | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const loadSummary = useCallback(async () => {
    setRefreshing(true);
    setMessage("");
    setHistoryRefresh((value) => value + 1);
    try {
      setSummary(await bridge.getUsageSummary());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Provider usage unavailable.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void bridge
      .getUsageSummary()
      .then((next) => {
        if (active) setSummary(next);
      })
      .catch((error) => {
        if (active)
          setMessage(error instanceof Error ? error.message : "Provider usage unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);

  const openUsage = useCallback(async (runtime: RuntimeConnection) => {
    setMessage("");
    try {
      const plans = await bridge.listRuntimeActionPlans(runtime.id, "usage");
      const plan =
        plans.find((candidate) => candidate.recommended && candidate.available) ??
        plans.find((candidate) => candidate.available);
      if (!plan) {
        setMessage(`No safe usage terminal is available for ${runtime.name} on this computer.`);
        return;
      }
      setUsagePlan(plan);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not open ${runtime.name} usage.`);
    }
  }, []);

  const summaryByProvider = new Map(summary?.providers.map((row) => [row.provider, row]) ?? []);
  const providerRows: ProviderUsageSummary[] = runtimes.map((runtime) => {
    return (
      summaryByProvider.get(runtime.id) ?? {
        provider: runtime.id,
        taskCount: 0,
        turnCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        provenance: "unavailable",
        detail: "No provider token usage has been reported for this runtime.",
      }
    );
  });
  for (const row of summary?.providers ?? []) {
    if (!providerRows.some((current) => current.provider === row.provider)) providerRows.push(row);
  }
  const codexUsage = summaryByProvider.get("codex");
  const codexBuckets = subscriptionBuckets(codexUsage?.subscription);
  const accountUsage = codexUsage?.accountUsage;
  const dailyUsage = accountUsage?.dailyUsageBuckets.slice(-28) ?? [];
  const dailyMaximum = Math.max(1, ...dailyUsage.map((bucket) => bucket.tokens));

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <CircleDollarSign />
        </span>
        <div>
          <h1>Usage and Budgets</h1>
          <p>
            What your CLIs recorded on this computer, live plan headroom, and the usage Integrator
            observed itself.
          </p>
        </div>
        <button
          className="secondary-button small usage-refresh-button"
          type="button"
          onClick={() => void loadSummary()}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? "spin" : ""} aria-hidden="true" />
          {refreshing ? "Refreshing" : "Refresh"}
        </button>
      </div>
      <UsageDashboard loadHistory={loadUsageHistory} refreshToken={historyRefresh} />
      <section className="settings-section">
        <header>
          <h2>Available now</h2>
          <p>
            Provider-owned limits where structured data exists, with a safe terminal path elsewhere.
          </p>
        </header>
        <div className="usage-headroom-list">
          {runtimes.map((runtime) => {
            const guidance = runtimeUsageGuidance(runtime);
            const installed = runtime.status !== "not_installed" && runtime.status !== "probing";
            const canOpen = installed && runtime.id !== "custom";
            const isCodex = runtime.id === "codex";
            return (
              <article className="usage-headroom-row" key={runtime.id}>
                <div className="usage-runtime-identity">
                  <ProviderIcon provider={runtime.id} label={runtime.name} />
                  <span>
                    <strong>{runtime.name}</strong>
                    <small>{runtime.status.replaceAll("_", " ")}</small>
                  </span>
                </div>
                {isCodex && codexBuckets.length > 0 ? (
                  <div className="usage-quota-buckets">
                    {codexBuckets.map((bucket, bucketIndex) => (
                      <div className="usage-quota-bucket" key={bucket.limitId ?? bucketIndex}>
                        <strong>{bucket.limitName || "Codex"}</strong>
                        {[bucket.primary, bucket.secondary]
                          .filter((window): window is SubscriptionWindow => window != null)
                          .map((window, windowIndex) => {
                            const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
                            return (
                              <div className="usage-quota-window" key={windowIndex}>
                                <span>
                                  <b>{Math.round(remaining)}% remaining</b>
                                  <small>
                                    {quotaWindowLabel(window.windowDurationMins)} ·{" "}
                                    {quotaResetLabel(window.resetsAt)}
                                  </small>
                                </span>
                                <div
                                  className="usage-quota-track"
                                  role="progressbar"
                                  aria-label={`${bucket.limitName || "Codex"} ${quotaWindowLabel(window.windowDurationMins)} remaining`}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-valuenow={Math.round(remaining)}
                                >
                                  <i style={{ width: `${remaining}%` }} />
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="usage-runtime-guidance">
                    <strong>{isCodex ? "Plan headroom unavailable" : guidance.label}</strong>
                    <small>
                      {isCodex
                        ? "Refresh after signing into the installed Codex runtime."
                        : guidance.detail}
                    </small>
                  </div>
                )}
                <div className="usage-runtime-action">
                  {isCodex ? (
                    <span>
                      {codexUsage?.subscription?.resetCreditsAvailable != null
                        ? `${codexUsage.subscription.resetCreditsAvailable} reset credits`
                        : codexUsage?.subscription?.planType || "Structured query"}
                    </span>
                  ) : canOpen ? (
                    <button
                      className="secondary-button small"
                      type="button"
                      onClick={() => void openUsage(runtime)}
                    >
                      {guidance.action}
                    </button>
                  ) : (
                    <span>
                      {runtime.status === "login_required"
                        ? "Sign in first"
                        : runtime.status === "not_installed"
                          ? "Install in Runtimes"
                          : "Unavailable"}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {usagePlan ? (
          <div className="usage-terminal-shell">
            <p>{usagePlan.description}</p>
            <RuntimeSetupTerminal
              plan={usagePlan}
              onClose={() => setUsagePlan(null)}
              onExit={() => void loadSummary()}
            />
          </div>
        ) : null}
        {message ? (
          <p className="settings-action-message" role="status">
            {message}
          </p>
        ) : null}
      </section>
      {accountUsage ? (
        <section className="settings-section">
          <header>
            <h2>Codex account activity</h2>
            <p>Provider-reported activity across Codex clients and devices, not just Integrator.</p>
          </header>
          <div className="usage-account-summary">
            <div>
              <span>Lifetime tokens</span>
              <strong>{formatTokens(accountUsage.summary.lifetimeTokens ?? 0)}</strong>
            </div>
            <div>
              <span>Peak day</span>
              <strong>{formatTokens(accountUsage.summary.peakDailyTokens ?? 0)}</strong>
            </div>
            <div>
              <span>Current streak</span>
              <strong>{accountUsage.summary.currentStreakDays ?? 0} days</strong>
            </div>
            <div>
              <span>Longest streak</span>
              <strong>{accountUsage.summary.longestStreakDays ?? 0} days</strong>
            </div>
          </div>
          {dailyUsage.length > 0 ? (
            <div className="usage-activity-chart" aria-label="Codex daily token activity">
              {dailyUsage.map((bucket) => (
                <Tooltip
                  key={bucket.startDate}
                  label={`${new Date(bucket.startDate).toLocaleDateString()}: ${bucket.tokens.toLocaleString()} tokens`}
                  placement="top"
                >
                  <i style={{ height: `${Math.max(4, (bucket.tokens / dailyMaximum) * 100)}%` }} />
                </Tooltip>
              ))}
            </div>
          ) : null}
          <p className="settings-measured-note">
            Updated {new Date(accountUsage.updatedAt).toLocaleString()} · provider reported.
          </p>
        </section>
      ) : null}
      <section className="settings-section">
        <header>
          <h2>Current task</h2>
          <p>Figures for the open task, each kept with its source and limits.</p>
        </header>
        <div className="settings-usage-list">
          {usage.metrics.map((metric) => (
            <div key={metric.label}>
              <span>
                <strong>{metric.label}</strong>
                <small>{metric.detail}</small>
              </span>
              <b>{metric.value}</b>
              <em>{metric.provenance.replace("_", " ")}</em>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <header>
          <h2>Local history</h2>
          <p>
            Usage persisted from Integrator tasks. It does not claim to be your provider bill or
            remaining plan allowance.
          </p>
        </header>
        {providerRows.length > 0 ? (
          <div className="settings-provider-usage">
            {providerRows.map((row) => (
              <article className="settings-provider-row" key={row.provider}>
                <div className="settings-provider-name">
                  <strong>{providerUsageLabel(row.provider)}</strong>
                  <small>{row.detail}</small>
                </div>
                <div className="settings-provider-stat">
                  <span>Tasks / turns</span>
                  <strong>
                    {row.taskCount} / {row.turnCount}
                  </strong>
                </div>
                <div className="settings-provider-stat">
                  <span>Processed tokens</span>
                  <strong>{formatTokens(row.totalTokens)}</strong>
                </div>
                <div className="settings-provider-stat">
                  <span>API cost estimate</span>
                  <strong>
                    {row.estimatedCostUsd != null && row.estimatedCostUsd > 0
                      ? formatEstimatedCost(row.estimatedCostUsd)
                      : "Not reported"}
                  </strong>
                </div>
                <div className="settings-provider-breakdown">
                  <span>Input {formatTokens(row.inputTokens)}</span>
                  <span>Cached {formatTokens(row.cachedInputTokens)}</span>
                  <span>Output {formatTokens(row.outputTokens)}</span>
                  <span>Reasoning {formatTokens(row.reasoningOutputTokens)}</span>
                </div>
                <span className={`settings-usage-badge settings-usage-badge--${row.provenance}`}>
                  {usageProvenanceLabel(row.provenance)}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="settings-empty">
            {message || "No provider usage has been recorded yet."}
          </div>
        )}
        {summary ? (
          <p className="settings-measured-note">
            Measured {new Date(summary.measuredAt).toLocaleString()} · missing totals stay missing.
          </p>
        ) : null}
      </section>
    </>
  );
}
