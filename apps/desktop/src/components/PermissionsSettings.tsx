import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import { ChevronRight, RotateCcw, ShieldCheck } from "lucide-react";
import {
  AUTO_REVIEW_FALLBACK,
  AUTO_REVIEW_POLICY,
  AUTO_REVIEW_PROFILE,
  AUTO_REVIEW_SETTING,
  DEFAULT_REVIEWER_EFFORT,
  normalizeAutoReview,
  readAutoReviewFallback,
  readAutoReviewPolicy,
  readAutoReviewRoute,
  resolveAutoReviewPolicy,
  suggestedReviewerModels,
  supportsNativeReviewer,
  type AutoReviewRoute,
  type ResolvedAutoReviewRoute,
} from "../autoReviewSettings";
import {
  bridge,
  resolveModelEffort,
  type ModelCatalogEntry,
  type RuntimeConnection,
  type RuntimeId,
} from "../bridge";
import { Dropdown, ProviderIcon } from "./Dropdown";
import { SettingRow, Switch } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";
import "./permissionsSettings.css";

const settleSpring = { type: "spring" as const, stiffness: 540, damping: 38, mass: 0.7 };

/** Catalogs report this sentinel for "whatever the runtime feels like". A
 * reviewer route has to name a model, so it never belongs in these pickers. */
const PROVIDER_DEFAULT = "Provider default";

export interface PermissionsSettingsProps {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}

export function PermissionsSettings({ settings, setSetting }: PermissionsSettingsProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) || document.documentElement.dataset.motion === "none";
  const runtimes = useInstalledRuntimes();
  const [catalogs, setCatalogs] = useState<Partial<Record<RuntimeId, ModelCatalogEntry[]>>>({});
  const [openRows, setOpenRows] = useState<readonly RuntimeId[]>([]);
  const catalogLoads = useRef(new Set<RuntimeId>());

  const installed = useMemo(
    // A runtime that is not on this machine cannot review anything, and
    // offering it would promise a reviewer that can never answer. Runtimes that
    // are installed but not yet handshaken (`degraded`, `login_required`) stay
    // listed: for the ACP CLIs that is the ordinary state until a session opens.
    () => (runtimes ?? []).filter((runtime) => runtime.status !== "not_installed"),
    [runtimes],
  );

  const fallbackCatalog = useCallback(
    (runtime: RuntimeId): ModelCatalogEntry[] =>
      installed
        .find((connection) => connection.id === runtime)
        ?.models.filter((id) => id !== PROVIDER_DEFAULT)
        .map((id) => ({ id, label: id })) ?? [],
    [installed],
  );

  const loadCatalog = useCallback(
    (runtime: RuntimeId) => {
      if (Object.hasOwn(catalogs, runtime) || catalogLoads.current.has(runtime)) return;
      catalogLoads.current.add(runtime);
      void Promise.resolve(bridge.listModelCatalog(runtime))
        .then((entries) =>
          setCatalogs((current) => ({
            ...current,
            [runtime]: entries.filter((entry) => entry.id !== PROVIDER_DEFAULT),
          })),
        )
        .catch(() =>
          setCatalogs((current) => ({ ...current, [runtime]: fallbackCatalog(runtime) })),
        )
        .finally(() => catalogLoads.current.delete(runtime));
    },
    [catalogs, fallbackCatalog],
  );

  const routes = useMemo(() => normalizeAutoReview(settings[AUTO_REVIEW_SETTING]), [settings]);

  const writeRoute = useCallback(
    (runtime: RuntimeId, patch: Partial<AutoReviewRoute>) => {
      const merged = {
        ...routes,
        [runtime]: { ...(routes[runtime] ?? { enabled: false }), ...patch },
      };
      // Store what the normalizer would read back. An impossible combination —
      // `native` on a runtime with no native reviewer — is then repaired once,
      // where the user made it, instead of every time something reads it.
      setSetting(AUTO_REVIEW_SETTING, normalizeAutoReview(merged));
    },
    [routes, setSetting],
  );

  const policy = readAutoReviewPolicy(settings);
  // Which runtimes run something other than the text in the editor below. The
  // resolver owns route -> global -> shipped; comparing against it is how this
  // note stays true if that order ever changes.
  const overriding = installed.filter(
    (runtime) => resolveAutoReviewPolicy(settings, runtime.id) !== policy,
  );

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <ShieldCheck />
        </span>
        <div>
          <h1>Permissions</h1>
          <p>The permission profile for new tasks and the task you came from.</p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Default permission profile</h2>
          <p>
            Applied to new tasks and the task you came from. Other existing tasks keep their last
            explicit choice.
          </p>
        </header>
        <SettingRow
          label="Default profile"
          description="Sets the current task now and preselects the permission picker for new tasks."
        >
          <Dropdown
            aria-label="Default profile"
            value={readSetting(settings, "permissions.defaultProfile", "project-write")}
            onChange={(value) => setSetting("permissions.defaultProfile", value)}
            options={[
              { value: "read-only", label: "Read only" },
              { value: "project-write", label: "Project write" },
              { value: "ask", label: "Ask as needed" },
              { value: AUTO_REVIEW_PROFILE, label: "Auto · reviewed by a model" },
              { value: "full-access", label: "Full access · explicit" },
            ]}
          />
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Auto review</h2>
          <p>
            Only tasks on the Auto profile use this. When one reaches the workspace boundary — a
            command that wants elevation, a network call, an edit outside the project — a second
            model answers in your place and its one-line reason lands in the transcript.
          </p>
          <p className="auto-review-caveat">
            It is a filter, not a sandbox. The reviewer reads file contents, command output and
            fetched pages that someone else may have written, and no model is a deterministic
            security guarantee. Turn it on for work you would have waved through anyway.
          </p>
        </header>
        {runtimes === null ? (
          <p className="auto-review-empty">Checking which runtimes are installed…</p>
        ) : installed.length === 0 ? (
          <p className="auto-review-empty">
            No runtime is installed on this machine, so there is nothing to review with. Install one
            under Runtimes and Models.
          </p>
        ) : (
          <motion.div
            className="auto-review-list"
            layout={reduceMotion ? false : "position"}
            transition={reduceMotion ? { duration: 0 } : settleSpring}
          >
            {installed.map((runtime) => (
              <AutoReviewRow
                key={runtime.id}
                runtime={runtime}
                reviewers={installed}
                route={readAutoReviewRoute(settings, runtime.id)}
                catalogs={catalogs}
                open={openRows.includes(runtime.id)}
                reduceMotion={reduceMotion}
                onOpenChange={(open) =>
                  setOpenRows((current) =>
                    open
                      ? current.includes(runtime.id)
                        ? current
                        : [...current, runtime.id]
                      : current.filter((id) => id !== runtime.id),
                  )
                }
                onNeedCatalog={loadCatalog}
                onChange={(patch) => writeRoute(runtime.id, patch)}
              />
            ))}
          </motion.div>
        )}
      </section>
      <section className="settings-section">
        <header>
          <h2>Reviewer policy</h2>
          <p>
            The rules every reviewer applies. The shipped policy tells it to treat everything it
            reads as evidence rather than instructions, to allow ordinary development work, and to
            deny when it is unsure.
          </p>
        </header>
        <SettingRow
          label="When the reviewer cannot answer"
          description="A timeout, a reviewer that will not start, or a verdict we cannot parse. Neither choice lets the action through on its own."
        >
          <Dropdown
            aria-label="When the reviewer cannot answer"
            value={readAutoReviewFallback(settings)}
            onChange={(value) => setSetting(AUTO_REVIEW_FALLBACK, value)}
            options={[
              { value: "ask", label: "Ask me" },
              { value: "deny", label: "Deny the request" },
            ]}
          />
        </SettingRow>
        <PolicyEditor
          policy={policy}
          overriding={overriding.map((runtime) => runtime.name)}
          reduceMotion={reduceMotion}
          onChange={(value) => setSetting(AUTO_REVIEW_POLICY, value)}
        />
      </section>
    </>
  );
}

/**
 * The installed runtimes, probed here rather than passed in.
 *
 * Permissions is not handed the runtime list the way Runtimes and Models is,
 * and an unforced probe is answered from the native cache the app already
 * warmed at startup, so this costs a round trip rather than a CLI launch.
 */
function useInstalledRuntimes(): RuntimeConnection[] | null {
  const [runtimes, setRuntimes] = useState<RuntimeConnection[] | null>(null);
  useEffect(() => {
    let active = true;
    // Optional call because not every host that mounts Settings implements the
    // whole bridge; a missing probe is an empty machine, not a crashed page.
    void Promise.resolve(bridge.probeRuntimes?.() ?? [])
      .then((list) => {
        if (active) setRuntimes(list);
      })
      // A probe that fails is not "every runtime is available"; it is none,
      // which shows the empty note instead of pickers that cannot be honoured.
      .catch(() => {
        if (active) setRuntimes([]);
      });
    return () => {
      active = false;
    };
  }, []);
  return runtimes;
}

function AutoReviewRow({
  runtime,
  reviewers,
  route,
  catalogs,
  open,
  reduceMotion,
  onOpenChange,
  onNeedCatalog,
  onChange,
}: {
  runtime: RuntimeConnection;
  reviewers: RuntimeConnection[];
  route: ResolvedAutoReviewRoute;
  catalogs: Partial<Record<RuntimeId, ModelCatalogEntry[]>>;
  open: boolean;
  reduceMotion: boolean;
  onOpenChange: (open: boolean) => void;
  onNeedCatalog: (runtime: RuntimeId) => void;
  onChange: (patch: Partial<AutoReviewRoute>) => void;
}) {
  const panelId = useId();
  const seeded = useRef<string | null>(null);
  const reviewerRuntime = route.reviewerRuntime;
  const reviewerName =
    reviewers.find((entry) => entry.id === reviewerRuntime)?.name ?? reviewerRuntime;
  const delegated = route.reviewer === "delegated";
  const catalog = catalogs[reviewerRuntime];
  // Suggestions are keyed on who reviews, never on whose task it is: offering
  // Claude's models to a Codex reviewer names models it cannot run.
  const options = useMemo(() => {
    const entries = catalog ?? [];
    const suggested = suggestedReviewerModels(reviewerRuntime, entries);
    return [...suggested, ...entries.filter((entry) => !suggested.some((s) => s.id === entry.id))];
  }, [catalog, reviewerRuntime]);
  const model = options.some((entry) => entry.id === route.model) ? route.model : options[0]?.id;
  const entry = options.find((candidate) => candidate.id === model);
  const efforts = entry?.efforts ?? [];
  const effort = resolveModelEffort(entry, route.effort ?? DEFAULT_REVIEWER_EFFORT);

  useEffect(() => {
    if (open || route.enabled) onNeedCatalog(reviewerRuntime);
  }, [open, route.enabled, reviewerRuntime, onNeedCatalog]);

  useEffect(() => {
    // A picker showing Haiku over a route that stored no model at all would be
    // a lie the user pays for: absent means "the runtime's own default", which
    // is the expensive one. Write down what the row is showing, once — the ref
    // is what makes it once, since a rejected write would otherwise be retried
    // on every render this row survives.
    if (!route.enabled || !delegated || route.model || !model) return;
    const seed = `${reviewerRuntime}:${model}`;
    if (seeded.current === seed) return;
    seeded.current = seed;
    onChange({ model, ...(effort ? { effort } : {}) });
  }, [route.enabled, route.model, delegated, model, effort, reviewerRuntime, onChange]);

  const summary = !route.enabled
    ? "Off"
    : route.reviewer === "native"
      ? `${runtime.name} reviews itself`
      : `Reviewed by ${reviewerName}${entry ? ` · ${entry.label}` : ""}${effort ? ` · ${effort}` : ""}`;

  return (
    <div className="auto-review-row" data-open={open || undefined}>
      <div className="auto-review-head">
        <button
          type="button"
          className="auto-review-summary"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronRight className="auto-review-chevron" aria-hidden />
          <ProviderIcon provider={runtime.id} label={runtime.name} />
          <span className="auto-review-identity">
            <strong>{runtime.name}</strong>
            <small>{summary}</small>
          </span>
        </button>
        <Switch
          checked={route.enabled}
          label={`Auto review on ${runtime.name}`}
          onChange={(value) => {
            onChange({ enabled: value });
            if (value) onOpenChange(true);
          }}
        />
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="auto-review-panel"
            id={panelId}
            key={panelId}
            initial={reduceMotion ? false : { opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: -4, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }
            }
            transition={reduceMotion ? { duration: 0 } : settleSpring}
          >
            <SettingRow
              label="Reviewed by"
              description="The reviewer does not have to be the runtime doing the work. A cheap model on another runtime is a reasonable guard for an expensive one."
            >
              <Dropdown
                aria-label={`Reviewer runtime for ${runtime.name}`}
                value={reviewerRuntime}
                onChange={(value) =>
                  onChange({
                    reviewerRuntime: value as RuntimeId,
                    // Native means the runtime reviewing itself, so pointing the
                    // route elsewhere is also a move to a reviewer we run. The
                    // model and effort go with it: an id from one catalog means
                    // nothing in another.
                    reviewer: value === runtime.id ? route.reviewer : "delegated",
                    model: undefined,
                    effort: undefined,
                  })
                }
                options={reviewers.map((candidate) => ({
                  value: candidate.id,
                  label:
                    candidate.id === runtime.id
                      ? `${candidate.name} · this runtime`
                      : candidate.name,
                  icon: <ProviderIcon provider={candidate.id} label={candidate.name} />,
                }))}
              />
            </SettingRow>
            <SettingRow
              label="Who answers"
              description={
                supportsNativeReviewer(runtime.id)
                  ? `${runtime.name} ships its own reviewer agent and chooses the model for it. Hand the decision to Integrator instead to pick the model yourself.`
                  : "This runtime has no reviewer of its own, so Integrator answers its permission requests with the model below."
              }
            >
              {supportsNativeReviewer(runtime.id) ? (
                <Dropdown
                  aria-label={`Who answers for ${runtime.name}`}
                  value={route.reviewer}
                  onChange={(value) =>
                    onChange(
                      value === "native"
                        ? { reviewer: "native", reviewerRuntime: runtime.id }
                        : { reviewer: "delegated" },
                    )
                  }
                  options={[
                    {
                      value: "native",
                      label: `${runtime.name}'s own reviewer`,
                      disabled: reviewerRuntime !== runtime.id,
                    },
                    { value: "delegated", label: "Integrator" },
                  ]}
                />
              ) : (
                <span
                  className="settings-unavailable"
                  aria-label={`${runtime.name} has no reviewer of its own`}
                >
                  Integrator · no built-in reviewer
                </span>
              )}
            </SettingRow>
            <SettingRow
              label="Reviewer model"
              description="The first three are the cheapest this reviewer reports; the rest of its catalog follows. The reviewer never inherits the task's model."
            >
              {!delegated ? (
                <span
                  className="settings-unavailable"
                  aria-label={`Reviewer model chosen by ${runtime.name}`}
                >
                  Chosen by {runtime.name}
                </span>
              ) : options.length > 0 ? (
                <Dropdown
                  aria-label={`Reviewer model for ${runtime.name}`}
                  value={model ?? ""}
                  onOpen={() => onNeedCatalog(reviewerRuntime)}
                  onChange={(value) => {
                    const chosen = options.find((candidate) => candidate.id === value);
                    onChange({
                      model: value,
                      effort: resolveModelEffort(chosen, route.effort ?? DEFAULT_REVIEWER_EFFORT),
                    });
                  }}
                  options={options.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.label,
                  }))}
                />
              ) : (
                <span className="settings-unavailable" aria-label="Reviewer model unavailable">
                  {catalog ? "No models reported" : "Checking models…"}
                </span>
              )}
            </SettingRow>
            <SettingRow
              label="Reviewer effort"
              description="Your turn waits while the reviewer thinks, so this starts as low as the model allows. Only provider-advertised levels are offered."
            >
              {delegated && efforts.length > 0 ? (
                <Dropdown
                  aria-label={`Reviewer effort for ${runtime.name}`}
                  value={effort ?? efforts[0]?.id}
                  onChange={(value) => onChange({ effort: value })}
                  options={efforts.map((option) => ({ value: option.id, label: option.label }))}
                />
              ) : (
                <span
                  className="settings-unavailable"
                  aria-label={`Reviewer effort unavailable for ${runtime.name}`}
                >
                  {!delegated
                    ? `Chosen by ${runtime.name}`
                    : catalog
                      ? "Not exposed by this model"
                      : "Checking capability…"}
                </span>
              )}
            </SettingRow>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function PolicyEditor({
  policy,
  overriding,
  reduceMotion,
  onChange,
}: {
  policy: string | undefined;
  overriding: string[];
  reduceMotion: boolean;
  onChange: (value: string) => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  // Every keystroke would otherwise be a write to disk, so the field holds its
  // own draft and commits on blur. `null` means "show what is stored".
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className="auto-review-policy" data-open={open || undefined}>
      <button
        type="button"
        className="auto-review-policy-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight className="auto-review-chevron" aria-hidden />
        <span>
          <strong>Policy text</strong>
          <small>{policy ? "Edited on this machine" : "The shipped policy"}</small>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="auto-review-policy-body"
            id={panelId}
            key={panelId}
            initial={reduceMotion ? false : { opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: -4, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }
            }
            transition={reduceMotion ? { duration: 0 } : settleSpring}
          >
            <textarea
              aria-label="Reviewer policy"
              rows={10}
              spellCheck={false}
              placeholder="Empty means the shipped policy, which is the only copy of these rules. Paste your own to replace it for every runtime."
              value={draft ?? policy ?? ""}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={(event) => {
                setDraft(null);
                const next = event.target.value.trim();
                if (next !== (policy ?? "")) onChange(next);
              }}
            />
            <div className="auto-review-policy-actions">
              <small>
                {overriding.length > 0
                  ? `${overriding.join(", ")} ${overriding.length === 1 ? "runs its own policy" : "run their own policies"} and ignore this text.`
                  : policy
                    ? "Every reviewer runs this text."
                    : "Every reviewer runs the shipped policy."}
              </small>
              <button
                type="button"
                className="ghost-button"
                disabled={!policy}
                onClick={() => {
                  setDraft(null);
                  onChange("");
                }}
              >
                <RotateCcw aria-hidden /> Restore the shipped policy
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
