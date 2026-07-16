use integrator_core::ProviderKind;

/// The primary followed by each distinct fallback.
pub(crate) fn provider_chain(
    primary: ProviderKind,
    fallbacks: &[ProviderKind],
) -> Vec<ProviderKind> {
    let mut chain = vec![primary];
    for provider in fallbacks {
        if !chain.contains(provider) {
            chain.push(*provider);
        }
    }
    chain
}

/// Only provider-side availability failures are worth retrying elsewhere.
pub(crate) fn is_worth_failing_over(code: &str) -> bool {
    matches!(
        code,
        "provider-unavailable"
            | "provider-timeout"
            | "provider-failed"
            | "provider-disconnected"
            | "provider-protocol"
            | "worker-failed"
    )
}
