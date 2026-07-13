import { useState } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  WifiOff,
} from "lucide-react";
import type { RuntimeActionKind, RuntimeConnection, RuntimeId } from "../bridge";
import { BrandMark } from "./BrandMark";
import { ProviderIcon } from "./Dropdown";

interface SetupViewProps {
  runtimes: RuntimeConnection[];
  onBack: () => void;
  onRuntimeAction: (runtime: RuntimeId, kind: RuntimeActionKind) => void;
  onFinish: () => void;
}

export function SetupView({ runtimes, onBack, onRuntimeAction, onFinish }: SetupViewProps) {
  const [step, setStep] = useState<"welcome" | "runtimes" | "privacy">("welcome");

  return (
    <main className="setup-screen" id="main-content">
      <header className="setup-topbar">
        <BrandMark />
        <button className="ghost-button" type="button" onClick={onBack}>
          <ArrowLeft /> Back to workspace
        </button>
      </header>
      <div className="setup-stage">
        <nav className="setup-progress" aria-label="Setup progress">
          {(["welcome", "runtimes", "privacy"] as const).map((id, index) => (
            <span
              key={id}
              data-active={step === id}
              data-complete={(["welcome", "runtimes", "privacy"] as const).indexOf(step) > index}
            >
              {index + 1}
            </span>
          ))}
        </nav>
        <AnimatePresence mode="wait" initial={false}>
          {step === "welcome" ? (
            <motion.section
              className="setup-content setup-welcome"
              key="welcome"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
            >
              <span className="setup-kicker">LOCAL AGENT WORKSPACE</span>
              <h1>
                Your coding agents,
                <br />
                in one calm workspace.
              </h1>
              <p>
                Use the subscriptions and CLIs already on this computer. AI Integrator keeps
                projects, transcripts, worktrees, and usage evidence local.
              </p>
              <div className="setup-feature-line">
                <span>
                  <TerminalSquare /> Real interactive terminals
                </span>
                <span>
                  <HardDrive /> Local session history
                </span>
                <span>
                  <ShieldCheck /> Vendor-owned login
                </span>
              </div>
              <button
                className="primary-button setup-next"
                type="button"
                onClick={() => setStep("runtimes")}
              >
                Find my agents <ArrowRight />
              </button>
            </motion.section>
          ) : null}
          {step === "runtimes" ? (
            <motion.section
              className="setup-content setup-runtimes"
              key="runtimes"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
            >
              <span className="setup-kicker">RUNTIME DISCOVERY</span>
              <h1>Connect what is already here.</h1>
              <p>
                We check executable names, versions, and login status. Passwords and tokens are
                never imported into AI Integrator.
              </p>
              <div className="runtime-list">
                {runtimes.map((runtime) => (
                  <div className="runtime-row" key={runtime.id} data-status={runtime.status}>
                    <span className={`runtime-logo runtime-logo--${runtime.id}`}>
                      <ProviderIcon provider={runtime.id} label={runtime.name} />
                    </span>
                    <span className="runtime-copy">
                      <strong>
                        {runtime.name}
                        <small>{runtime.version ?? "Not detected"}</small>
                      </strong>
                      <span>{runtime.detail}</span>
                      <code>{runtime.command}</code>
                    </span>
                    {runtime.status === "connected" ? (
                      <span className="runtime-connected">
                        <Check /> Connected
                      </span>
                    ) : null}
                    {runtime.status === "degraded" ? (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => onRuntimeAction(runtime.id, "update")}
                      >
                        <RefreshCw /> Review
                      </button>
                    ) : null}
                    {runtime.status === "login_required" ? (
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => onRuntimeAction(runtime.id, "login")}
                      >
                        <RefreshCw /> Sign in
                      </button>
                    ) : null}
                    {runtime.status === "not_installed" ? (
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => onRuntimeAction(runtime.id, "install")}
                      >
                        Install
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="setup-actions">
                <button className="ghost-button" type="button" onClick={() => setStep("welcome")}>
                  <ArrowLeft /> Back
                </button>
                <button className="primary-button" type="button" onClick={() => setStep("privacy")}>
                  Continue <ArrowRight />
                </button>
              </div>
            </motion.section>
          ) : null}
          {step === "privacy" ? (
            <motion.section
              className="setup-content setup-privacy"
              key="privacy"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
            >
              <span className="setup-kicker">LOCAL-FIRST BY DEFAULT</span>
              <h1>Know exactly what leaves your machine.</h1>
              <p>
                Your selected runtime sends prompts and chosen context to its provider. Integrator
                itself needs no account, cloud database, or credential proxy.
              </p>
              <div className="privacy-map">
                <div>
                  <HardDrive />
                  <span>
                    <strong>Stays here</strong>Tasks, transcripts, Git state, preferences, usage
                    ledger
                  </span>
                </div>
                <div>
                  <ArrowRight className="privacy-arrow" />
                </div>
                <div>
                  <TerminalSquare />
                  <span>
                    <strong>Vendor CLI</strong>Login cache, model requests, provider quota
                  </span>
                </div>
                <div>
                  <WifiOff />
                  <span>
                    <strong>Works offline</strong>History, diffs, Git review, settings, session
                    search
                  </span>
                </div>
              </div>
              <div className="setup-actions">
                <button className="ghost-button" type="button" onClick={() => setStep("runtimes")}>
                  <ArrowLeft /> Back
                </button>
                <button className="primary-button" type="button" onClick={onFinish}>
                  <Check /> Open AI Integrator
                </button>
              </div>
            </motion.section>
          ) : null}
        </AnimatePresence>
      </div>
    </main>
  );
}
