use chrono::{DateTime, Utc};
use integrator_core::ProviderKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use session_store::LocalStore;

/// One provider-reported rate-limit window. `resets_at` is a Unix timestamp
/// in seconds; absent fields remain absent rather than being inferred.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionWindow {
    used_percent: f64,
    #[serde(default)]
    window_duration_mins: Option<u64>,
    #[serde(default)]
    resets_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionCredits {
    has_credits: bool,
    unlimited: bool,
    #[serde(default)]
    balance: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSpendLimit {
    limit: String,
    used: String,
    remaining_percent: f64,
    resets_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuotaBucket {
    #[serde(default)]
    limit_id: Option<String>,
    #[serde(default)]
    limit_name: Option<String>,
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    primary: Option<SubscriptionWindow>,
    #[serde(default)]
    secondary: Option<SubscriptionWindow>,
    #[serde(default)]
    credits: Option<SubscriptionCredits>,
    #[serde(default)]
    individual_limit: Option<SubscriptionSpendLimit>,
    #[serde(default)]
    rate_limit_reached_type: Option<String>,
}

/// Provider-reported subscription quota. Never inferred: only providers that
/// publish rate-limit windows populate this value.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuota {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    primary: Option<SubscriptionWindow>,
    #[serde(default)]
    secondary: Option<SubscriptionWindow>,
    #[serde(default)]
    buckets: Vec<SubscriptionQuotaBucket>,
    #[serde(default)]
    reset_credits_available: Option<u64>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountUsageSummary {
    #[serde(default)]
    lifetime_tokens: Option<u64>,
    #[serde(default)]
    peak_daily_tokens: Option<u64>,
    #[serde(default)]
    longest_running_turn_sec: Option<u64>,
    #[serde(default)]
    current_streak_days: Option<u64>,
    #[serde(default)]
    longest_streak_days: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountUsageBucket {
    start_date: String,
    tokens: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountUsage {
    summary: ProviderAccountUsageSummary,
    #[serde(default)]
    daily_usage_buckets: Vec<ProviderAccountUsageBucket>,
    updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageSummary {
    pub(crate) provider: String,
    pub(crate) task_count: u64,
    pub(crate) turn_count: u64,
    pub(crate) input_tokens: u64,
    pub(crate) cached_input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) reasoning_output_tokens: u64,
    pub(crate) total_tokens: u64,
    pub(crate) model_context_window: Option<u64>,
    /// Vendor-computed API-equivalent cost in USD. It is an estimate, not a
    /// bill, and stays absent rather than being inferred elsewhere.
    pub(crate) estimated_cost_usd: Option<f64>,
    pub(crate) subscription: Option<SubscriptionQuota>,
    /// Account-wide activity is separate from Integrator-local task history.
    pub(crate) account_usage: Option<ProviderAccountUsage>,
    pub(crate) provenance: &'static str,
    pub(crate) detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub(crate) providers: Vec<ProviderUsageSummary>,
    pub(crate) measured_at: DateTime<Utc>,
}

/// Persist the renderer-safe allowlist from a provider rate-limit snapshot.
/// Sparse updates retain previously reported windows; unknown fields never
/// cross into settings or renderer DTOs.
pub(crate) fn store_provider_quota(store: &LocalStore, provider: ProviderKind, params: &Value) {
    let Some(snapshot) = params.get("rateLimits") else {
        return;
    };
    let key = format!("provider-quota.{}", provider.as_str());
    let existing = store
        .get_setting(&key)
        .ok()
        .flatten()
        .map(|setting| setting.value)
        .unwrap_or(Value::Null);
    let window = |name: &str| -> Value {
        snapshot
            .get(name)
            .filter(|window| window.get("usedPercent").is_some())
            .map(sanitized_subscription_window)
            .unwrap_or_else(|| existing.get(name).cloned().unwrap_or(Value::Null))
    };
    let plan_type = snapshot
        .get("planType")
        .and_then(Value::as_str)
        .or_else(|| existing.get("planType").and_then(Value::as_str))
        .map(str::to_owned);
    let buckets = params
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .values()
                .map(sanitized_rate_limit_snapshot)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            let mut buckets = existing
                .get("buckets")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let next = sanitized_rate_limit_snapshot(snapshot);
            let limit_id = next.get("limitId").and_then(Value::as_str);
            if let Some(limit_id) = limit_id {
                if let Some(index) = buckets.iter().position(|bucket| {
                    bucket.get("limitId").and_then(Value::as_str) == Some(limit_id)
                }) {
                    buckets[index] = next;
                } else {
                    buckets.push(next);
                }
            }
            buckets
        });
    let reset_credits_available = params
        .pointer("/rateLimitResetCredits/availableCount")
        .and_then(Value::as_u64)
        .or_else(|| {
            existing
                .get("resetCreditsAvailable")
                .and_then(Value::as_u64)
        });
    let value = serde_json::json!({
        "planType": plan_type,
        "primary": window("primary"),
        "secondary": window("secondary"),
        "buckets": buckets,
        "resetCreditsAvailable": reset_credits_available,
        "updatedAt": Utc::now().to_rfc3339(),
    });
    let _ = store.set_setting(&key, value);
}

pub(crate) fn sanitized_rate_limit_snapshot(snapshot: &Value) -> Value {
    serde_json::json!({
        "limitId": snapshot.get("limitId").and_then(Value::as_str),
        "limitName": snapshot.get("limitName").and_then(Value::as_str),
        "planType": snapshot.get("planType").and_then(Value::as_str),
        "primary": snapshot
            .get("primary")
            .map(sanitized_subscription_window)
            .unwrap_or(Value::Null),
        "secondary": snapshot
            .get("secondary")
            .map(sanitized_subscription_window)
            .unwrap_or(Value::Null),
        "credits": snapshot.get("credits").map(|credits| serde_json::json!({
            "hasCredits": credits.get("hasCredits").and_then(Value::as_bool),
            "unlimited": credits.get("unlimited").and_then(Value::as_bool),
            "balance": credits.get("balance").and_then(Value::as_str),
        })).unwrap_or(Value::Null),
        "individualLimit": snapshot.get("individualLimit").map(|limit| serde_json::json!({
            "limit": limit.get("limit").and_then(Value::as_str),
            "used": limit.get("used").and_then(Value::as_str),
            "remainingPercent": limit.get("remainingPercent").and_then(Value::as_f64),
            "resetsAt": limit.get("resetsAt").and_then(Value::as_i64),
        })).unwrap_or(Value::Null),
        "rateLimitReachedType": snapshot
            .get("rateLimitReachedType")
            .and_then(Value::as_str),
    })
}

fn sanitized_subscription_window(window: &Value) -> Value {
    serde_json::json!({
        "usedPercent": window.get("usedPercent").and_then(Value::as_f64),
        "windowDurationMins": window.get("windowDurationMins").and_then(Value::as_u64),
        "resetsAt": window.get("resetsAt").and_then(Value::as_i64),
    })
}

pub(crate) fn store_provider_account_usage(
    store: &LocalStore,
    provider: ProviderKind,
    params: &Value,
) {
    let Some(summary) = params.get("summary") else {
        return;
    };
    let daily_usage_buckets = params
        .get("dailyUsageBuckets")
        .and_then(Value::as_array)
        .map(|buckets| {
            buckets
                .iter()
                .filter_map(|bucket| {
                    Some(serde_json::json!({
                        "startDate": bucket.get("startDate")?.as_str()?,
                        "tokens": bucket.get("tokens")?.as_u64()?,
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let value = serde_json::json!({
        "summary": {
            "lifetimeTokens": summary.get("lifetimeTokens").cloned().unwrap_or(Value::Null),
            "peakDailyTokens": summary.get("peakDailyTokens").cloned().unwrap_or(Value::Null),
            "longestRunningTurnSec": summary
                .get("longestRunningTurnSec")
                .cloned()
                .unwrap_or(Value::Null),
            "currentStreakDays": summary.get("currentStreakDays").cloned().unwrap_or(Value::Null),
            "longestStreakDays": summary.get("longestStreakDays").cloned().unwrap_or(Value::Null),
        },
        "dailyUsageBuckets": daily_usage_buckets,
        "updatedAt": Utc::now().to_rfc3339(),
    });
    let key = format!("provider-account-usage.{}", provider.as_str());
    let _ = store.set_setting(&key, value);
}
