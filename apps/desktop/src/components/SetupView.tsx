import { useState } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderPlus,
  GitBranch,
  HardDrive,
  RefreshCw,
  ScrollText,
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
  onCreateProject: () => void;
  onFinish: () => void;
}

type SetupStep = "welcome" | "runtimes" | "execution" | "privacy";

const STEPS: Array<{ id: SetupStep; label: string }> = [
  { id: "welcome", label: "Welcome" },
  { id: "runtimes", label: "Runtimes" },
  { id: "execution", label: "How it runs" },
  { id: "privacy", label: "Your data" },
];

const stepTransition = { duration: 0.38, ease: [0.22, 1, 0.36, 1] as const };

const stepVariants = {
  initial: { opacity: 0, y: 18 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { ...stepTransition, staggerChildren: 0.055, delayChildren: 0.04 },
  },
  exit: { opacity: 0, y: -10, transition: { duration: 0.16, ease: "easeIn" as const } },
};

const itemVariants = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0, transition: stepTransition },
};

const LOGIN_REVIEW_DETAILS = new Set([
  "auth-probe-requires-acp",
  "auth-not-probed",
  "auth-probe-failed",
  "auth-probe-timeout",
  "auth-status-unknown",
]);

function degradedRuntimeAction(runtime: RuntimeConnection): RuntimeActionKind {
  return LOGIN_REVIEW_DETAILS.has(runtime.detail) ? "login" : "update";
}

export function SetupView({
  runtimes,
  onBack,
  onRuntimeAction,
  onCreateProject,
  onFinish,
}: SetupViewProps) {
  const [step, setStep] = useState<SetupStep>("welcome");
  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const connectedCount = runtimes.filter((runtime) => runtime.status === "connected").length;

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
          {STEPS.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              data-active={step === entry.id}
              data-complete={stepIndex > index}
              disabled={index >= stepIndex}
              onClick={() => setStep(entry.id)}
              aria-current={step === entry.id ? "step" : undefined}
            >
              <span className="setup-progress-bar" aria-hidden="true" />
              {entry.label}
            </button>
          ))}
        </nav>
        <AnimatePresence mode="wait" initial={false}>
          {step === "welcome" ? (
            <motion.section
              className="setup-content setup-welcome"
              key="welcome"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <motion.span className="setup-kicker" variants={itemVariants}>
                LOCAL-FIRST AGENT WORKSPACE
              </motion.span>
              <motion.h1 variants={itemVariants}>
                Every coding agent.
                <br />
                One native workspace.
              </motion.h1>
              <motion.p variants={itemVariants}>
                AI Integrator orchestrates the agent CLIs already installed on this machine — Claude
                Code, Codex, Gemini, and more. Each task runs as a real terminal process under your
                existing subscription, and everything it produces stays on disk.
              </motion.p>
              <motion.div className="setup-feature-line" variants={itemVariants}>
                <span>
                  <TerminalSquare /> Real PTY terminals
                </span>
                <span>
                  <HardDrive /> Transcripts stored locally
                </span>
                <span>
                  <ShieldCheck /> Sign-in stays with each vendor
                </span>
              </motion.div>
              <motion.div variants={itemVariants}>
                <button
                  className="primary-button setup-next"
                  type="button"
                  onClick={() => setStep("runtimes")}
                >
                  Set up my runtimes <ArrowRight />
                </button>
              </motion.div>
            </motion.section>
          ) : null}
          {step === "runtimes" ? (
            <motion.section
              className="setup-content setup-runtimes"
              key="runtimes"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <motion.span className="setup-kicker" variants={itemVariants}>
                RUNTIME DETECTION
              </motion.span>
              <motion.h1 variants={itemVariants}>Connect your installed CLIs.</motion.h1>
              <motion.p variants={itemVariants}>
                AI Integrator scans your PATH for known agent executables and reads each one's
                version and login state. Authentication always happens in the vendor's own flow —
                passwords, tokens, and API keys never pass through or get stored by AI Integrator.
              </motion.p>
              <motion.div className="runtime-list" variants={itemVariants}>
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
                        onClick={() => onRuntimeAction(runtime.id, degradedRuntimeAction(runtime))}
                      >
                        <RefreshCw />
                        {degradedRuntimeAction(runtime) === "login" ? "Sign in" : "Review"}
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
              </motion.div>
              <motion.p className="setup-footnote" variants={itemVariants}>
                {connectedCount > 0
                  ? `${connectedCount} runtime${connectedCount === 1 ? "" : "s"} ready. You can connect more at any time from Settings.`
                  : "No runtime is connected yet — you can continue and connect one later from Settings."}
              </motion.p>
              <motion.div className="setup-actions" variants={itemVariants}>
                <button className="ghost-button" type="button" onClick={() => setStep("welcome")}>
                  <ArrowLeft /> Back
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => setStep("execution")}
                >
                  Continue <ArrowRight />
                </button>
              </motion.div>
            </motion.section>
          ) : null}
          {step === "execution" ? (
            <motion.section
              className="setup-content setup-execution"
              key="execution"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <motion.span className="setup-kicker" variants={itemVariants}>
                EXECUTION MODEL
              </motion.span>
              <motion.h1 variants={itemVariants}>How your tasks actually run.</motion.h1>
              <motion.p variants={itemVariants}>
                Every task is a real CLI process, not an API wrapper. You get exactly the agent you
                would have in a terminal — with review and history built around it.
              </motion.p>
              <motion.div className="setup-exec-grid" variants={itemVariants}>
                <div>
                  <TerminalSquare />
                  <strong>Spawn</strong>
                  <span>
                    Each task launches its runtime in a dedicated pseudo-terminal, so interactive
                    prompts, progress output, and permission requests behave exactly as they do in
                    your shell.
                  </span>
                </div>
                <div>
                  <GitBranch />
                  <strong>Review</strong>
                  <span>
                    Every file the agent touches shows up as a unified diff against your checkout.
                    Approve changes file by file and commit from the built-in Git review.
                  </span>
                </div>
                <div>
                  <ScrollText />
                  <strong>Record</strong>
                  <span>
                    Every turn is appended to a transcript on disk. Search past sessions, fork a
                    task from any point, and review diffs before anything merges.
                  </span>
                </div>
              </motion.div>
              <motion.div className="setup-actions" variants={itemVariants}>
                <button className="ghost-button" type="button" onClick={() => setStep("runtimes")}>
                  <ArrowLeft /> Back
                </button>
                <button className="primary-button" type="button" onClick={() => setStep("privacy")}>
                  Continue <ArrowRight />
                </button>
              </motion.div>
            </motion.section>
          ) : null}
          {step === "privacy" ? (
            <motion.section
              className="setup-content setup-privacy"
              key="privacy"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <motion.span className="setup-kicker" variants={itemVariants}>
                DATA BOUNDARIES
              </motion.span>
              <motion.h1 variants={itemVariants}>
                What leaves the machine, and what stays local.
              </motion.h1>
              <motion.p variants={itemVariants}>
                The only network traffic is your runtime talking to its own provider: your prompts
                plus the context you choose to attach. AI Integrator has no account, no telemetry
                pipeline, and no server sitting between you and your model.
              </motion.p>
              <motion.div className="privacy-map" variants={itemVariants}>
                <div>
                  <HardDrive />
                  <span>
                    <strong>Stays on this machine</strong>Projects, transcripts, Git state, usage
                    ledger, and preferences
                  </span>
                </div>
                <div>
                  <ArrowRight className="privacy-arrow" />
                </div>
                <div>
                  <TerminalSquare />
                  <span>
                    <strong>Sent by your runtime</strong>Prompts and attached context, using the
                    login cached by the vendor CLI
                  </span>
                </div>
                <div>
                  <WifiOff />
                  <span>
                    <strong>Works offline</strong>Session history, diff review, Git operations,
                    settings, and transcript search
                  </span>
                </div>
              </motion.div>
              <motion.div className="setup-actions setup-finish" variants={itemVariants}>
                <button className="ghost-button" type="button" onClick={() => setStep("execution")}>
                  <ArrowLeft /> Back
                </button>
                <div className="setup-finish-buttons">
                  <button className="secondary-button" type="button" onClick={onFinish}>
                    <Check /> Open AI Integrator
                  </button>
                  <button className="primary-button" type="button" onClick={onCreateProject}>
                    <FolderPlus /> Add a project
                  </button>
                </div>
              </motion.div>
            </motion.section>
          ) : null}
        </AnimatePresence>
      </div>
    </main>
  );
}
