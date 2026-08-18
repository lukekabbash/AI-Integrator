import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import {
  AUTO_REVIEW_FALLBACK,
  AUTO_REVIEW_POLICY,
  AUTO_REVIEW_PROFILE,
  AUTO_REVIEW_REVIEWERS,
  DEFAULT_REVIEWER_EFFORT,
  normalizeAutoReviewReviewers,
  readAutoReviewFallback,
  readAutoReviewPolicy,
  readAutoReviewReviewers,
  suggestedReviewerModels,
  type AutoReviewReviewer,
} from "../autoReviewSettings";
import {
  bridge,
  resolveModelEffort,
  type ModelCatalogEntry,
  type RuntimeConnection,
  type RuntimeId,
} from "../bridge";
import { Dropdown, ProviderIcon } from "./Dropdown";
import { SettingRow } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";
import "./permissionsSettings.css";

const PROVIDER_DEFAULT = "Provider default";
const MAX_REVIEWERS = 4;

export interface PermissionsSettingsProps {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}

export function PermissionsSettings({ settings, setSetting }: PermissionsSettingsProps) {
  const runtimes = useInstalledRuntimes();
  const [catalogs, setCatalogs] = useState<Partial<Record<RuntimeId, ModelCatalogEntry[]>>>({});
  const catalogLoads = useRef(new Set<RuntimeId>());
  const initializedReviewers = useRef(false);

  const installed = useMemo(
    () => (runtimes ?? []).filter((runtime) => runtime.status !== "not_installed"),
    [runtimes],
  );
  const reviewers = useMemo(() => readAutoReviewReviewers(settings), [settings]);

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

  useEffect(() => {
    if (runtimes === null || initializedReviewers.current || reviewers.length > 0) return;
    const first = installed.find((runtime) => runtime.id === "codex") ?? installed[0];
    if (!first) return;
    initializedReviewers.current = true;
    setSetting(AUTO_REVIEW_REVIEWERS, [{ runtime: first.id }]);
  }, [installed, reviewers.length, runtimes, setSetting]);

  const writeReviewers = useCallback(
    (next: AutoReviewReviewer[]) =>
      setSetting(AUTO_REVIEW_REVIEWERS, normalizeAutoReviewReviewers(next)),
    [setSetting],
  );

  const changeReviewer = useCallback(
    (index: number, patch: Partial<AutoReviewReviewer>) =>
      writeReviewers(
        reviewers.map((reviewer, reviewerIndex) =>
          reviewerIndex === index ? { ...reviewer, ...patch } : reviewer,
        ),
      ),
    [reviewers, writeReviewers],
  );

  const moveReviewer = useCallback(
    (index: number, offset: -1 | 1) => {
      const destination = index + offset;
      if (destination < 0 || destination >= reviewers.length) return;
      const next = [...reviewers];
      [next[index], next[destination]] = [next[destination], next[index]];
      writeReviewers(next);
    },
    [reviewers, writeReviewers],
  );

  const policy = readAutoReviewPolicy(settings);

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <ShieldCheck />
        </span>
        <div>
          <h1>Permissions</h1>
          <p>Choose what agents can do.</p>
        </div>
      </div>

      <section className="settings-section">
        <header>
          <h2>Default permission profile</h2>
        </header>
        <SettingRow label="Default profile" description="Used for new tasks and this task.">
          <Dropdown
            aria-label="Default profile"
            value={readSetting(settings, "permissions.defaultProfile", "project-write")}
            onChange={(value) => setSetting("permissions.defaultProfile", value)}
            options={[
              { value: "read-only", label: "Read only" },
              { value: "project-write", label: "Project write" },
              { value: "ask", label: "Ask as needed" },
              { value: AUTO_REVIEW_PROFILE, label: "Auto" },
              { value: "full-access", label: "Full access" },
            ]}
          />
        </SettingRow>
      </section>

      <section className="settings-section">
        <header>
          <h2>Auto reviewers</h2>
          <p>These models are tried in order. Codex uses its built-in reviewer.</p>
        </header>
        {runtimes === null ? (
          <p className="auto-review-empty">Checking installed runtimes…</p>
        ) : installed.length === 0 ? (
          <p className="auto-review-empty">Install a runtime to add an auto reviewer.</p>
        ) : (
          <div className="auto-review-list" aria-label="Auto reviewer fallbacks">
            {reviewers.map((reviewer, index) => (
              <ReviewerRow
                key={reviewer.runtime + "-" + index}
                index={index}
                reviewer={reviewer}
                runtimes={installed}
                catalogs={catalogs}
                canRemove={reviewers.length > 1}
                canMoveUp={index > 0}
                canMoveDown={index < reviewers.length - 1}
                onNeedCatalog={loadCatalog}
                onChange={(patch) => changeReviewer(index, patch)}
                onMove={(offset) => moveReviewer(index, offset)}
                onRemove={() =>
                  writeReviewers(reviewers.filter((_, itemIndex) => itemIndex !== index))
                }
              />
            ))}
            {reviewers.length < MAX_REVIEWERS ? (
              <button
                type="button"
                className="auto-review-add"
                onClick={() =>
                  writeReviewers([
                    ...reviewers,
                    { runtime: reviewers.at(-1)?.runtime ?? installed[0].id },
                  ])
                }
              >
                <Plus aria-hidden /> Add fallback
              </button>
            ) : null}
          </div>
        )}
        <SettingRow label="If no reviewer answers" description="Choose the safe fallback.">
          <Dropdown
            aria-label="If no reviewer answers"
            value={readAutoReviewFallback(settings)}
            onChange={(value) => setSetting(AUTO_REVIEW_FALLBACK, value)}
            options={[
              { value: "ask", label: "Ask me" },
              { value: "deny", label: "Deny" },
            ]}
          />
        </SettingRow>
      </section>

      <section className="settings-section">
        <header>
          <h2>Reviewer policy</h2>
          <p>Applied to every auto reviewer.</p>
        </header>
        <PolicyEditor policy={policy} onChange={(value) => setSetting(AUTO_REVIEW_POLICY, value)} />
      </section>
    </>
  );
}

function useInstalledRuntimes(): RuntimeConnection[] | null {
  const [runtimes, setRuntimes] = useState<RuntimeConnection[] | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.resolve(bridge.probeRuntimes?.() ?? [])
      .then((list) => {
        if (active) setRuntimes(list);
      })
      .catch(() => {
        if (active) setRuntimes([]);
      });
    return () => {
      active = false;
    };
  }, []);
  return runtimes;
}

function ReviewerRow({
  index,
  reviewer,
  runtimes,
  catalogs,
  canRemove,
  canMoveUp,
  canMoveDown,
  onNeedCatalog,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  reviewer: AutoReviewReviewer;
  runtimes: RuntimeConnection[];
  catalogs: Partial<Record<RuntimeId, ModelCatalogEntry[]>>;
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onNeedCatalog: (runtime: RuntimeId) => void;
  onChange: (patch: Partial<AutoReviewReviewer>) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const seeded = useRef<string | null>(null);
  const catalog = catalogs[reviewer.runtime];
  const options = useMemo(() => {
    const entries = catalog ?? [];
    const suggested = suggestedReviewerModels(reviewer.runtime, entries);
    return [
      ...suggested,
      ...entries.filter((entry) => !suggested.some((item) => item.id === entry.id)),
    ];
  }, [catalog, reviewer.runtime]);
  const model = options.some((entry) => entry.id === reviewer.model)
    ? reviewer.model
    : options[0]?.id;
  const entry = options.find((candidate) => candidate.id === model);
  const efforts = entry?.efforts ?? [];
  const effort = resolveModelEffort(entry, reviewer.effort ?? DEFAULT_REVIEWER_EFFORT);

  useEffect(() => onNeedCatalog(reviewer.runtime), [onNeedCatalog, reviewer.runtime]);

  useEffect(() => {
    if (reviewer.model || !model) return;
    const seed = reviewer.runtime + ":" + model;
    if (seeded.current === seed) return;
    seeded.current = seed;
    onChange({ model, ...(effort ? { effort } : {}) });
  }, [effort, model, onChange, reviewer.model, reviewer.runtime]);

  return (
    <div className="auto-review-route">
      <span
        className="auto-review-order"
        aria-label={index === 0 ? "Primary reviewer" : "Fallback " + index}
      >
        {index + 1}
      </span>
      <div className="auto-review-route-fields">
        <Dropdown
          aria-label={"Reviewer runtime " + (index + 1)}
          value={reviewer.runtime}
          onChange={(value) =>
            onChange({ runtime: value as RuntimeId, model: undefined, effort: undefined })
          }
          options={runtimes.map((runtime) => ({
            value: runtime.id,
            label: runtime.name,
            icon: <ProviderIcon provider={runtime.id} label={runtime.name} />,
          }))}
        />
        {options.length > 0 ? (
          <Dropdown
            aria-label={"Reviewer model " + (index + 1)}
            value={model ?? ""}
            onOpen={() => onNeedCatalog(reviewer.runtime)}
            onChange={(value) => {
              const chosen = options.find((candidate) => candidate.id === value);
              onChange({
                model: value,
                effort: resolveModelEffort(chosen, reviewer.effort ?? DEFAULT_REVIEWER_EFFORT),
              });
            }}
            options={options.map((candidate) => ({
              value: candidate.id,
              label: candidate.label,
            }))}
          />
        ) : (
          <span className="settings-unavailable">
            {catalog ? "No models available" : "Checking models…"}
          </span>
        )}
        {efforts.length > 0 ? (
          <Dropdown
            aria-label={"Reviewer effort " + (index + 1)}
            value={effort ?? efforts[0]?.id}
            onChange={(value) => onChange({ effort: value })}
            options={efforts.map((option) => ({ value: option.id, label: option.label }))}
          />
        ) : null}
      </div>
      <div className="auto-review-route-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={"Move reviewer " + (index + 1) + " up"}
          disabled={!canMoveUp}
          onClick={() => onMove(-1)}
        >
          <ArrowUp aria-hidden />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={"Move reviewer " + (index + 1) + " down"}
          disabled={!canMoveDown}
          onClick={() => onMove(1)}
        >
          <ArrowDown aria-hidden />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={"Remove reviewer " + (index + 1)}
          disabled={!canRemove}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </button>
      </div>
    </div>
  );
}

function PolicyEditor({
  policy,
  onChange,
}: {
  policy: string | undefined;
  onChange: (value: string) => void;
}) {
  const [defaultPolicy, setDefaultPolicy] = useState("");
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.resolve(bridge.defaultAutoReviewPolicy())
      .then((value) => {
        if (active) setDefaultPolicy(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const shownPolicy = draft ?? policy ?? defaultPolicy;
  return (
    <div className="auto-review-policy-body">
      <textarea
        aria-label="Reviewer policy"
        rows={12}
        spellCheck={false}
        value={shownPolicy}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          setDraft(null);
          const next = event.target.value.trim();
          const stored = next === defaultPolicy.trim() ? "" : next;
          if (stored !== (policy ?? "")) onChange(stored);
        }}
      />
      <div className="auto-review-policy-actions">
        <button
          type="button"
          className="ghost-button"
          disabled={!policy && draft === null}
          onClick={() => {
            setDraft(null);
            onChange("");
          }}
        >
          <RotateCcw aria-hidden /> Restore default
        </button>
      </div>
    </div>
  );
}
