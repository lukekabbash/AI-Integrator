import { isAcpConnectionError, isDefinitivePreSubmitDisconnect } from "./bridgeErrors";

type AcpTurnFailure = {
  phase: "setup" | "submit";
  error: unknown;
};

export interface AcpTurnRecoveryOptions<Prepared> {
  setup(): Promise<Prepared>;
  submit(prepared: Prepared): Promise<void>;
  reset(): void;
}

async function attemptAcpTurn<Prepared>(
  options: AcpTurnRecoveryOptions<Prepared>,
): Promise<AcpTurnFailure | undefined> {
  let prepared: Prepared;
  try {
    prepared = await options.setup();
  } catch (error) {
    return { phase: "setup", error };
  }
  try {
    await options.submit(prepared);
    return undefined;
  } catch (error) {
    return { phase: "submit", error };
  }
}

export async function runAcpTurnWithRecovery<Prepared>(
  options: AcpTurnRecoveryOptions<Prepared>,
): Promise<void> {
  const firstFailure = await attemptAcpTurn(options);
  if (!firstFailure) return;

  options.reset();
  const canRetry =
    firstFailure.phase === "setup"
      ? isAcpConnectionError(firstFailure.error)
      : isDefinitivePreSubmitDisconnect(firstFailure.error);
  if (!canRetry) throw firstFailure.error;

  // Native `provider-disconnected` is returned before the user item is
  // persisted or the provider prompt starts. Other submission errors have
  // uncertain outcomes and deliberately never cross this retry boundary.
  const retryFailure = await attemptAcpTurn(options);
  if (!retryFailure) return;
  options.reset();
  throw retryFailure.error;
}
