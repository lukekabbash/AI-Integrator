import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  LockKeyhole,
  Package,
  Plus,
  Search,
  Server,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  bridge,
  resolveModelEffort,
  type IntegratorMcpOverview,
  type IntegratorMcpServer,
  type IntegratorSkillsOverview,
  type ModelCatalogEntry,
  type RuntimeConnection,
  type RuntimeId,
  type SpecialistRuntimeCatalog,
} from "../bridge";
import {
  createSpecialist,
  normalizeSpecialists,
  serviceLabel,
  SPECIALIST_LEVELS,
  type SpecialistRoute,
  type SpecialistService,
  type SpecialistServiceLevel,
  type SpecialistSetting,
} from "../subagentSettings";
import { Dropdown, ProviderIcon, type DropdownOption } from "./Dropdown";

type SettingsMap = Record<string, unknown>;
type IntegratorSkillInfo = IntegratorSkillsOverview["skills"][number];

type PluginSkillGroup = {
  id: string;
  source: string;
  skills: IntegratorSkillInfo[];
};

const TARGETS: Array<{ runtime: RuntimeId; label: string }> = [
  { runtime: "codex", label: "Codex (OpenAI)" },
  { runtime: "claude", label: "Claude" },
  { runtime: "antigravity", label: "Antigravity (Gemini)" },
  { runtime: "cursor", label: "Cursor" },
  { runtime: "grok", label: "Grok Build" },
  { runtime: "kimi", label: "Kimi Code" },
];

const FALLBACK_EFFORTS: Record<string, string[]> = {
  codex: ["minimal", "low", "medium", "high"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  antigravity: ["low", "medium", "high"],
  cursor: [],
  grok: [],
  kimi: [],
};

function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      className="switch"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function routeSummary(route: SpecialistRoute): string {
  return [
    TARGETS.find((item) => item.runtime === route.runtime)?.label ?? route.runtime,
    route.model,
    route.effort,
  ]
    .filter(Boolean)
    .join(" · ");
}

function serviceSummary(service: SpecialistService): string {
  if (!service.enabled) return "Not offered";
  const fallbackCount = service.fallbacksEnabled ? service.fallbacks.length : 0;
  return fallbackCount === 0
    ? "No fallbacks"
    : `${fallbackCount} fallback${fallbackCount === 1 ? "" : "s"}`;
}

function SpecialistRouteIcons({ specialist }: { specialist: SpecialistSetting }) {
  const enabledRuntimes = [
    ...new Set(
      specialist.serviceLevels
        .filter((service) => service.enabled)
        .map((service) => service.primary.runtime),
    ),
  ];
  const runtimes = enabledRuntimes.length
    ? enabledRuntimes
    : [
        specialist.serviceLevels.find((service) => service.level === "standard")?.primary.runtime,
      ].filter((runtime): runtime is string => Boolean(runtime));
  const labels = runtimes.map(
    (runtime) => TARGETS.find((target) => target.runtime === runtime)?.label ?? runtime,
  );
  return (
    <span className="specialist-route-icons" aria-label={`Routes: ${labels.join(", ")}`}>
      {runtimes.slice(0, 3).map((runtime) => (
        <ProviderIcon
          key={runtime}
          provider={runtime}
          label={TARGETS.find((target) => target.runtime === runtime)?.label ?? runtime}
        />
      ))}
      {runtimes.length > 3 ? <small>+{runtimes.length - 3}</small> : null}
    </span>
  );
}

function skillPluginId(source: string, name: string): string | null {
  if (source === "integrator" || source === "missing" || !name.includes(":")) return null;
  return name.split(":")[0] ?? null;
}

function pluginLabel(source: string, name: string): string {
  if (source === "integrator") return "My skill";
  if (source === "missing") return "No longer installed";
  const pluginId = skillPluginId(source, name);
  if (source === "first-party") return pluginId ? `Built-in plugin · ${pluginId}` : "Built in";
  return pluginId ? `Plugin · ${pluginId}` : "Plugin skill";
}

function groupPluginSkills(skills: IntegratorSkillInfo[]): PluginSkillGroup[] {
  const groups = new Map<string, PluginSkillGroup>();
  for (const skill of skills) {
    const id = skillPluginId(skill.source, skill.name);
    if (!id) continue;
    const group = groups.get(id) ?? { id, source: skill.source, skills: [] };
    group.skills.push(skill);
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function mcpState(server: IntegratorMcpServer): string {
  if (!server.enabled) return "Disabled";
  if (server.authorization?.state === "notConnected") return "Sign-in needed";
  if (server.authorization?.state === "needsAttention") return "Needs attention";
  if (server.credentials?.some((credential) => !credential.configured)) return "Key needed";
  return "Ready";
}

function RouteEditor({
  label,
  route,
  catalogs,
  onChange,
  onRemove,
}: {
  label: string;
  route: SpecialistRoute;
  catalogs: Record<string, ModelCatalogEntry[]>;
  onChange: (route: SpecialistRoute) => void;
  onRemove?: () => void;
}) {
  const catalog = catalogs[route.runtime] ?? [];
  const runtimeOptions: DropdownOption[] = TARGETS.map((target) => ({
    value: target.runtime,
    label: target.label,
    icon: <ProviderIcon provider={target.runtime} label={target.label} />,
  }));
  const modelOptions: DropdownOption[] = [
    { value: "", label: "Provider default" },
    ...catalog
      .filter((entry) => entry.id !== "Provider default")
      .map((entry) => ({ value: entry.id, label: entry.label || entry.id })),
  ];
  if (route.model && !modelOptions.some((option) => option.value === route.model)) {
    modelOptions.push({ value: route.model, label: route.model });
  }
  const model = catalog.find((entry) => entry.id === route.model);
  const efforts = model?.efforts?.length
    ? model.efforts
    : (FALLBACK_EFFORTS[route.runtime] ?? []).map((id) => ({ id, label: id }));
  return (
    <div className="specialist-route-row">
      <span className="specialist-route-kind">{label}</span>
      <Dropdown
        compact
        placement="up"
        aria-label={`${label} runtime`}
        value={route.runtime}
        options={runtimeOptions}
        onChange={(runtime) => onChange({ runtime })}
      />
      <Dropdown
        compact
        placement="up"
        aria-label={`${label} model`}
        value={route.model ?? ""}
        options={modelOptions}
        onChange={(modelId) => {
          const entry = catalog.find((item) => item.id === modelId);
          onChange({
            ...route,
            model: modelId || undefined,
            effort: modelId ? resolveModelEffort(entry, route.effort) : undefined,
          });
        }}
      />
      <Dropdown
        compact
        placement="up"
        aria-label={`${label} reasoning effort`}
        value={route.effort ?? ""}
        options={[
          { value: "", label: "Default effort" },
          ...efforts.map((effort) => ({ value: effort.id, label: effort.label || effort.id })),
        ]}
        onChange={(effort) => onChange({ ...route, effort: effort || undefined })}
      />
      {onRemove ? (
        <button
          className="specialist-icon-button"
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          <X />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

function ServiceEditor({
  service,
  expanded,
  catalogs,
  onExpand,
  onChange,
}: {
  service: SpecialistService;
  expanded: boolean;
  catalogs: Record<string, ModelCatalogEntry[]>;
  onExpand: () => void;
  onChange: (service: SpecialistService) => void;
}) {
  return (
    <div className="specialist-service" data-expanded={expanded} data-enabled={service.enabled}>
      <div className="specialist-service-summary">
        <button
          type="button"
          className="specialist-service-open"
          onClick={onExpand}
          aria-expanded={expanded}
        >
          <strong>{serviceLabel(service.level)}</strong>
          <span>{routeSummary(service.primary)}</span>
          <small>{serviceSummary(service)}</small>
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </button>
        <Switch
          checked={service.enabled}
          label={`Offer ${serviceLabel(service.level)} service`}
          onChange={(enabled) => onChange({ ...service, enabled })}
        />
      </div>
      {expanded ? (
        <div className="specialist-service-detail">
          <div className="specialist-service-intro">
            <span>
              <strong>{serviceLabel(service.level)} route</strong>
              <small>
                Fallbacks run only when the primary runtime is unavailable before launch.
              </small>
            </span>
          </div>
          <RouteEditor
            label="Primary"
            route={service.primary}
            catalogs={catalogs}
            onChange={(primary) => onChange({ ...service, primary })}
          />
          <div className="specialist-fallback-toggle">
            <span>
              <strong>Use fallback runtimes</strong>
              <small>Turn this off to force this service level to one provider.</small>
            </span>
            <Switch
              checked={service.fallbacksEnabled}
              label={`Use ${serviceLabel(service.level)} fallbacks`}
              onChange={(fallbacksEnabled) => onChange({ ...service, fallbacksEnabled })}
            />
          </div>
          {service.fallbacksEnabled
            ? service.fallbacks.map((route, index) => (
                <RouteEditor
                  key={`${route.runtime}-${index}`}
                  label={`Fallback ${index + 1}`}
                  route={route}
                  catalogs={catalogs}
                  onChange={(nextRoute) =>
                    onChange({
                      ...service,
                      fallbacks: service.fallbacks.map((item, itemIndex) =>
                        itemIndex === index ? nextRoute : item,
                      ),
                    })
                  }
                  onRemove={() =>
                    onChange({
                      ...service,
                      fallbacks: service.fallbacks.filter((_, itemIndex) => itemIndex !== index),
                    })
                  }
                />
              ))
            : null}
          {service.fallbacksEnabled && service.fallbacks.length < 4 ? (
            <button
              className="specialist-add-fallback"
              type="button"
              onClick={() =>
                onChange({
                  ...service,
                  fallbacks: [...service.fallbacks, { runtime: service.primary.runtime }],
                })
              }
            >
              <Plus /> Add fallback
            </button>
          ) : null}
          <p className="specialist-service-note">
            <CircleHelp /> {serviceLabel(service.level)} fallbacks stay within the selected{" "}
            {serviceLabel(service.level)} tier.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function SubagentsSettings({
  settings,
  setSetting,
  runtimes,
}: {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  runtimes: RuntimeConnection[];
}) {
  const specialists = normalizeSpecialists(settings["delegation.profiles"]);
  const maxConcurrent =
    typeof settings["delegation.maxConcurrent"] === "number"
      ? (settings["delegation.maxConcurrent"] as number)
      : 3;
  const delegationGuidance =
    typeof settings["delegation.instruction"] === "string"
      ? (settings["delegation.instruction"] as string)
      : "";
  const prefersReducedMotion = useReducedMotion();
  const guidanceMotionDisabled =
    prefersReducedMotion ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");
  const [guidanceOpen, setGuidanceOpen] = useState(true);
  const [selectedId, setSelectedId] = useState(specialists[0]?.id ?? "");
  const [expandedLevel, setExpandedLevel] = useState<SpecialistServiceLevel>("standard");
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalogEntry[]>>({});
  const [skills, setSkills] = useState<IntegratorSkillsOverview | null>(null);
  const [mcps, setMcps] = useState<IntegratorMcpOverview | null>(null);
  const [inventoryError, setInventoryError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [specialistDescription, setSpecialistDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationMessage, setGenerationMessage] = useState("");
  const usableTargets = TARGETS.filter((target) =>
    runtimes.some(
      (connection) => connection.id === target.runtime && connection.status !== "not_installed",
    ),
  );
  const preferredRuntime = settings["models.defaultRuntime"];
  const [creatorRuntime, setCreatorRuntime] = useState<RuntimeId>(() => {
    if (
      typeof preferredRuntime === "string" &&
      usableTargets.some((target) => target.runtime === preferredRuntime)
    ) {
      return preferredRuntime as RuntimeId;
    }
    return usableTargets[0]?.runtime ?? "codex";
  });
  const resolvedCreatorRuntime = usableTargets.some((target) => target.runtime === creatorRuntime)
    ? creatorRuntime
    : (usableTargets[0]?.runtime ?? "codex");
  const sequence = useRef(0);

  const selected = specialists.find((specialist) => specialist.id === selectedId) ?? specialists[0];

  useEffect(() => {
    let current = true;
    for (const target of TARGETS) {
      void bridge
        .listModelCatalog(target.runtime)
        .then((entries) => {
          if (current) setCatalogs((value) => ({ ...value, [target.runtime]: entries }));
        })
        .catch(() => undefined);
    }
    void Promise.all([bridge.listIntegratorSkills(), bridge.listIntegratorMcps()])
      .then(([skillOverview, mcpOverview]) => {
        if (!current) return;
        setSkills(skillOverview);
        setMcps(mcpOverview);
        setInventoryError("");
      })
      .catch((error) => {
        if (current)
          setInventoryError(
            error instanceof Error ? error.message : "Capabilities could not be loaded",
          );
      });
    return () => {
      current = false;
    };
  }, []);

  const save = (next: SpecialistSetting[]) => setSetting("delegation.profiles", next);
  const updateSelected = (patch: Partial<SpecialistSetting>) => {
    if (!selected) return;
    save(
      specialists.map((specialist) =>
        specialist.id === selected.id ? { ...specialist, ...patch } : specialist,
      ),
    );
  };
  const updateService = (next: SpecialistService) => {
    if (!selected) return;
    updateSelected({
      serviceLevels: selected.serviceLevels.map((service) =>
        service.level === next.level ? next : service,
      ),
    });
  };
  const addSpecialist = () => {
    let nextSequence = sequence.current + 1;
    while (specialists.some((item) => item.id === `specialist-local-${nextSequence}`)) {
      nextSequence += 1;
    }
    sequence.current = nextSequence;
    const specialist = createSpecialist(nextSequence);
    save([...specialists, specialist]);
    setSelectedId(specialist.id);
    setExpandedLevel("standard");
  };
  const generateSpecialist = async (event: FormEvent) => {
    event.preventDefault();
    const description = specialistDescription.trim();
    if (!description || generating) return;
    if (!usableTargets.length) {
      setGenerationMessage("Connect a runtime before creating a specialist.");
      return;
    }
    setGenerating(true);
    setGenerationMessage("");
    try {
      const modelCatalogs = (
        await Promise.all(
          usableTargets.map(async (target): Promise<SpecialistRuntimeCatalog> => ({
            runtime: target.runtime,
            models: (await bridge.listModelCatalog(target.runtime)).filter(
              (entry) => entry.id.trim() && entry.id !== "Provider default",
            ),
          })),
        )
      ).filter((catalog) => catalog.models.length > 0);
      if (modelCatalogs.length < 2) {
        throw new Error(
          "Connect two runtimes with available models so the specialist can have a primary route and fallback.",
        );
      }
      const generatorFallback = modelCatalogs.find(
        (catalog) => catalog.runtime !== resolvedCreatorRuntime,
      );
      const generated = await bridge.generateSpecialist(
        description,
        {
          runtime: resolvedCreatorRuntime,
          fallbacks: generatorFallback ? [generatorFallback.runtime] : [],
        },
        modelCatalogs,
      );
      const specialist = { ...generated, enabled: false };
      save([...specialists, specialist]);
      setSelectedId(specialist.id);
      setExpandedLevel("standard");
      setSpecialistDescription("");
      setGenerationMessage(`${specialist.label} was created disabled. Review it, then enable it.`);
    } catch (error) {
      setGenerationMessage(
        error instanceof Error ? error.message : "The specialist could not be created.",
      );
    } finally {
      setGenerating(false);
    }
  };
  const removeSelected = () => {
    if (!selected) return;
    const index = specialists.findIndex((specialist) => specialist.id === selected.id);
    const next = specialists.filter((specialist) => specialist.id !== selected.id);
    save(next);
    setSelectedId(next[Math.min(index, Math.max(0, next.length - 1))]?.id ?? "");
  };
  const toggleSkill = (name: string) => {
    if (!selected) return;
    updateSelected({
      skillIds: selected.skillIds.includes(name)
        ? selected.skillIds.filter((item) => item !== name)
        : [...selected.skillIds, name],
    });
  };
  const togglePlugin = (names: string[]) => {
    if (!selected) return;
    const pluginSkills = new Set(names);
    const allAssigned = names.every((name) => selected.skillIds.includes(name));
    updateSelected({
      skillIds: allAssigned
        ? selected.skillIds.filter((name) => !pluginSkills.has(name))
        : [...selected.skillIds, ...names.filter((name) => !selected.skillIds.includes(name))],
    });
  };
  const toggleMcp = (name: string) => {
    if (!selected) return;
    updateSelected({
      mcpServerIds: selected.mcpServerIds.includes(name)
        ? selected.mcpServerIds.filter((item) => item !== name)
        : [...selected.mcpServerIds, name],
    });
  };
  const assignedSkills = (selected?.skillIds ?? []).map(
    (name) =>
      skills?.skills.find((skill) => skill.name === name) ?? {
        name,
        description: "No longer installed",
        source: "missing",
        enabled: false,
        defaultEnabled: false,
        invocationCount: 0,
      },
  );
  const assignedMcps = (selected?.mcpServerIds ?? []).map(
    (name) =>
      mcps?.servers.find((server) => server.name === name) ?? {
        name,
        source: "missing",
        origin: "Unavailable",
        enabled: false,
        transport: "stdio" as const,
      },
  );
  const search = pickerSearch.trim().toLowerCase();
  const pluginGroups = groupPluginSkills(skills?.skills ?? []);
  const visiblePluginGroups = pluginGroups.filter(
    (group) =>
      !search ||
      group.id.toLowerCase().includes(search) ||
      group.skills.some((skill) =>
        `${skill.name} ${skill.description}`.toLowerCase().includes(search),
      ),
  );
  const visibleSkills = (skills?.skills ?? []).filter(
    (skill) => !search || `${skill.name} ${skill.description}`.toLowerCase().includes(search),
  );
  const visibleMcps = (mcps?.servers ?? []).filter(
    (server) => !search || `${server.name} ${server.origin}`.toLowerCase().includes(search),
  );
  const offered =
    selected?.serviceLevels
      .filter((service) => service.enabled)
      .map((service) => serviceLabel(service.level)) ?? [];
  const runtimeInstalled = (runtime: string) =>
    runtimes.some(
      (connection) => connection.id === runtime && connection.status !== "not_installed",
    );

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Users />
        </span>
        <div>
          <h1>Subagents</h1>
          <p>
            Create specialists for focused delegated work. Each one receives only the capabilities
            you assign.
          </p>
        </div>
      </div>

      <section className="specialist-safeguards" aria-labelledby="specialist-safeguards-title">
        <h2 id="specialist-safeguards-title">Safeguards</h2>
        <div className="specialist-safeguards-row">
          <label>
            <span>Concurrent subagents</span>
            <input
              className="subagent-number"
              type="number"
              min={1}
              max={4}
              value={maxConcurrent}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value))
                  setSetting(
                    "delegation.maxConcurrent",
                    Math.min(4, Math.max(1, Math.round(value))),
                  );
              }}
            />
          </label>
          <div className="specialist-guidance" data-open={guidanceOpen}>
            <button
              className="specialist-guidance-trigger"
              type="button"
              aria-expanded={guidanceOpen}
              aria-controls="delegation-guidance-panel"
              onClick={() => setGuidanceOpen((open) => !open)}
            >
              <span>
                <strong>Delegation guidance</strong>
                <small>How the lead chooses, briefs, and hears back from specialists.</small>
              </span>
              <motion.span
                className="specialist-guidance-chevron"
                animate={{ rotate: guidanceOpen ? 180 : 0 }}
                transition={
                  guidanceMotionDisabled
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 520, damping: 34, mass: 0.7 }
                }
              >
                <ChevronDown />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {guidanceOpen ? (
                <motion.div
                  id="delegation-guidance-panel"
                  className="specialist-guidance-panel"
                  initial={{ height: 0, opacity: 0, y: guidanceMotionDisabled ? 0 : -6 }}
                  animate={{ height: "auto", opacity: 1, y: 0 }}
                  exit={{ height: 0, opacity: 0, y: guidanceMotionDisabled ? 0 : -4 }}
                  transition={
                    guidanceMotionDisabled
                      ? { duration: 0 }
                      : {
                          height: { duration: 0.24, ease: [0.2, 0, 0, 1] },
                          opacity: { duration: 0.16, ease: "easeOut" },
                          y: { duration: 0.2, ease: [0.2, 0, 0, 1] },
                        }
                  }
                >
                  <label>
                    <span>
                      <strong>Instructions for the lead agent</strong>
                      <small>
                        Set a standing rule for when to delegate, what evidence to request, and how
                        work should be handed back.
                      </small>
                    </span>
                    <textarea
                      aria-label="Instructions for the lead agent"
                      rows={4}
                      value={delegationGuidance}
                      placeholder="For example: use read-only specialists for investigations, ask for exact evidence, and keep handoffs concise."
                      onChange={(event) => setSetting("delegation.instruction", event.target.value)}
                    />
                  </label>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </section>

      <section className="specialist-section" aria-labelledby="specialists-title">
        <header>
          <h2 id="specialists-title">Specialists</h2>
          <p>Choose when each specialist should be used and what it is equipped to access.</p>
        </header>
        <form className="specialist-generator" onSubmit={generateSpecialist}>
          <textarea
            aria-label="Describe a specialist"
            value={specialistDescription}
            maxLength={6_000}
            rows={3}
            placeholder="Describe the work you want a specialist to own, how it should work, and what it may need."
            onChange={(event) => setSpecialistDescription(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="specialist-generator-controls">
            <span>
              <Sparkles /> Chooses models, fallback, and capabilities · starts disabled
            </span>
            <Dropdown
              compact
              placement="up"
              aria-label="Specialist creator runtime"
              value={resolvedCreatorRuntime}
              options={usableTargets.map((target) => ({
                value: target.runtime,
                label: target.label,
                icon: <ProviderIcon provider={target.runtime} label={target.label} />,
              }))}
              onChange={(runtime) => setCreatorRuntime(runtime as RuntimeId)}
            />
            <button
              type="submit"
              aria-label={generating ? "Creating specialist" : "Create specialist from description"}
              disabled={generating || !specialistDescription.trim() || !usableTargets.length}
            >
              {generating ? <span aria-hidden="true">•••</span> : <ArrowUp />}
            </button>
          </div>
        </form>
        {generationMessage ? (
          <p className="specialist-generator-message" role="status" aria-live="polite">
            {generationMessage}
          </p>
        ) : null}
        <div className="specialist-workbench">
          <aside className="specialist-roster" aria-label="Specialists">
            <div
              className="specialist-roster-list"
              role="listbox"
              aria-label="Configured specialists"
            >
              {specialists.map((specialist) => {
                const primaryRuntime =
                  specialist.serviceLevels.find((service) => service.enabled)?.primary.runtime ??
                  "codex";
                return (
                  <div
                    role="option"
                    tabIndex={0}
                    aria-selected={selected?.id === specialist.id}
                    className="specialist-roster-item"
                    key={specialist.id}
                    data-selected={selected?.id === specialist.id}
                    data-enabled={specialist.enabled}
                    onClick={() => setSelectedId(specialist.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(specialist.id);
                      }
                    }}
                  >
                    <SpecialistRouteIcons specialist={specialist} />
                    <span>
                      <strong>{specialist.label}</strong>
                      <small>
                        {specialist.serviceLevels
                          .filter((service) => service.enabled)
                          .map((service) => serviceLabel(service.level))
                          .join(" · ") || "No service levels"}
                        {!runtimeInstalled(primaryRuntime) ? " · Runtime unavailable" : ""}
                      </small>
                      <small>
                        {specialist.skillIds.length} skills · {specialist.mcpServerIds.length} MCP
                        {specialist.mcpServerIds.length === 1 ? "" : "s"}
                      </small>
                    </span>
                    <Switch
                      checked={specialist.enabled}
                      label={`Enable ${specialist.label}`}
                      onChange={(enabled) =>
                        save(
                          specialists.map((item) =>
                            item.id === specialist.id ? { ...item, enabled } : item,
                          ),
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
            <button className="specialist-new" type="button" onClick={addSpecialist}>
              <Plus /> New specialist
            </button>
          </aside>

          {selected ? (
            <div className="specialist-editor">
              <div className="specialist-editor-head">
                <input
                  aria-label="Specialist name"
                  value={selected.label}
                  onChange={(event) => updateSelected({ label: event.target.value })}
                />
                <span>Saved locally</span>
                <Switch
                  checked={selected.enabled}
                  label={`Enable ${selected.label}`}
                  onChange={(enabled) => updateSelected({ enabled })}
                />
                <button
                  className="specialist-icon-button"
                  type="button"
                  aria-label={`Delete ${selected.label}`}
                  onClick={removeSelected}
                >
                  <Trash2 />
                </button>
              </div>

              <label className="specialist-best-for">
                <span>
                  <strong>Best for</strong>
                  <small>Shown to the orchestrator when choosing where to delegate.</small>
                </span>
                <input
                  value={selected.bestFor}
                  maxLength={2_000}
                  placeholder="What should the orchestrator send to this specialist?"
                  onChange={(event) => updateSelected({ bestFor: event.target.value })}
                />
              </label>

              <div className="specialist-service-levels">
                <div className="specialist-subheading">
                  <span>
                    <strong>Service levels</strong>
                    <small>
                      Offer this specialist at the cost and quality levels you want the orchestrator
                      to use.
                    </small>
                  </span>
                  <span>
                    {offered.length ? `${offered.join(" · ")} enabled` : "No levels enabled"}
                  </span>
                </div>
                <div className="specialist-service-columns" aria-hidden="true">
                  <span>Level</span>
                  <span>Primary route</span>
                  <span>Fallback state</span>
                </div>
                {SPECIALIST_LEVELS.map((level) => {
                  const service = selected.serviceLevels.find((item) => item.level === level)!;
                  return (
                    <ServiceEditor
                      key={level}
                      service={service}
                      expanded={expandedLevel === level}
                      catalogs={catalogs}
                      onExpand={() => setExpandedLevel(level)}
                      onChange={updateService}
                    />
                  );
                })}
              </div>

              <details className="specialist-working-guidance">
                <summary>
                  <span>
                    <strong>Working guidance</strong>
                    <small>Child-only instructions</small>
                  </span>
                  <ChevronRight />
                </summary>
                <label>
                  <span>Instructions this specialist receives on every new delegation</span>
                  <textarea
                    rows={5}
                    maxLength={65_536}
                    value={selected.workingGuidance}
                    placeholder="Role, workflow, quality bar, and expected deliverables."
                    onChange={(event) => updateSelected({ workingGuidance: event.target.value })}
                  />
                </label>
              </details>

              <div className="specialist-bottom-grid">
                <section className="specialist-access">
                  <span>
                    <strong>Access</strong>
                    <small>The orchestrator may request less access, never more.</small>
                  </span>
                  <div
                    className="specialist-segmented"
                    role="radiogroup"
                    aria-label="Specialist access ceiling"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected.access === "read-only"}
                      data-selected={selected.access === "read-only"}
                      onClick={() => updateSelected({ access: "read-only" })}
                    >
                      <LockKeyhole /> Read only
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected.access === "project-write"}
                      data-selected={selected.access === "project-write"}
                      onClick={() => updateSelected({ access: "project-write" })}
                    >
                      May edit project
                    </button>
                  </div>
                </section>

                <section className="specialist-capabilities">
                  <div className="specialist-capabilities-head">
                    <span>
                      <strong>Equipped capabilities</strong>
                      <small>
                        Add whole Plugins or individual Skills—even when they’re off in main chats.
                        MCP servers stay explicit.
                      </small>
                    </span>
                    <button type="button" onClick={() => setPickerOpen((open) => !open)}>
                      <Plus /> Add capabilities
                    </button>
                  </div>
                  {pickerOpen ? (
                    <div className="specialist-capability-picker">
                      <label>
                        <Search />
                        <input
                          autoFocus
                          aria-label="Search capabilities"
                          value={pickerSearch}
                          onChange={(event) => setPickerSearch(event.target.value)}
                          placeholder="Search Skills, Plugins, and MCPs"
                        />
                      </label>
                      {inventoryError ? <p role="alert">{inventoryError}</p> : null}
                      <div className="specialist-capability-options">
                        {visiblePluginGroups.length ? (
                          <h3>
                            Plugins <span>{visiblePluginGroups.length}</span>
                          </h3>
                        ) : null}
                        {visiblePluginGroups.map((group) => {
                          const names = group.skills.map((skill) => skill.name);
                          const assignedCount = names.filter((name) =>
                            selected.skillIds.includes(name),
                          ).length;
                          const allAssigned = assignedCount === names.length;
                          const disabledInMainChats = group.skills.filter(
                            (skill) => !skill.enabled,
                          ).length;
                          return (
                            <button
                              key={group.id}
                              type="button"
                              role="checkbox"
                              aria-label={`${allAssigned ? "Remove" : "Add"} ${group.id} plugin`}
                              aria-checked={
                                allAssigned ? true : assignedCount > 0 ? "mixed" : false
                              }
                              data-kind="plugin"
                              data-selected={assignedCount > 0}
                              onClick={() => togglePlugin(names)}
                            >
                              <Package />
                              <span>
                                <strong>{group.id}</strong>
                                <small>
                                  {group.skills.length} installed Skill
                                  {group.skills.length === 1 ? "" : "s"}
                                  {disabledInMainChats
                                    ? ` · ${disabledInMainChats} off in main chats`
                                    : ""}
                                </small>
                              </span>
                              <small>
                                {allAssigned
                                  ? "All added"
                                  : assignedCount
                                    ? `Add remaining ${names.length - assignedCount}`
                                    : `Add all ${names.length}`}
                              </small>
                            </button>
                          );
                        })}
                        {visibleSkills.length ? (
                          <h3>
                            Individual Skills <span>{visibleSkills.length}</span>
                          </h3>
                        ) : null}
                        {visibleSkills.map((skill) => {
                          const checked = selected.skillIds.includes(skill.name);
                          const fromPlugin = skillPluginId(skill.source, skill.name) !== null;
                          return (
                            <button
                              key={skill.name}
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              data-selected={checked}
                              onClick={() => toggleSkill(skill.name)}
                            >
                              {fromPlugin ? <Package /> : <Sparkles />}
                              <span>
                                <strong>{skill.name.split(":").at(-1)}</strong>
                                <small>{pluginLabel(skill.source, skill.name)}</small>
                              </span>
                              <small>
                                {skill.enabled
                                  ? checked
                                    ? "Added"
                                    : "Ready"
                                  : checked
                                    ? "Added · Specialist only"
                                    : "Specialist only"}
                              </small>
                            </button>
                          );
                        })}
                        {visibleMcps.length ? (
                          <h3>
                            MCP servers <span>{visibleMcps.length}</span>
                          </h3>
                        ) : null}
                        {visibleMcps.map((server) => {
                          const checked = selected.mcpServerIds.includes(server.name);
                          return (
                            <button
                              key={server.name}
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              disabled={!server.enabled}
                              data-selected={checked}
                              onClick={() => toggleMcp(server.name)}
                            >
                              <Server />
                              <span>
                                <strong>{server.name.split(":").at(-1)}</strong>
                                <small>MCP · {server.origin}</small>
                              </span>
                              <small>
                                {server.enabled
                                  ? checked
                                    ? "Added"
                                    : mcpState(server)
                                  : "Enable in MCPs"}
                              </small>
                            </button>
                          );
                        })}
                        {!skills && !mcps && !inventoryError ? <p>Loading capabilities…</p> : null}
                      </div>
                    </div>
                  ) : null}
                  <div className="specialist-capability-list">
                    <h3>
                      <span>Skills &amp; Plugins</span>
                      <small>{assignedSkills.length} assigned</small>
                    </h3>
                    {assignedSkills.map((skill) => {
                      const installed = skill.source !== "missing";
                      const fromPlugin = skillPluginId(skill.source, skill.name) !== null;
                      return (
                        <div key={skill.name} data-ready={installed}>
                          {fromPlugin ? <Package /> : <Sparkles />}
                          <span>
                            <strong>{skill.name.split(":").at(-1)}</strong>
                            <small>Skill · {pluginLabel(skill.source, skill.name)}</small>
                          </span>
                          <small>
                            {!installed
                              ? "Unavailable"
                              : skill.enabled
                                ? "Ready"
                                : "Specialist only"}
                          </small>
                          <button
                            type="button"
                            aria-label={`Remove ${skill.name}`}
                            onClick={() => toggleSkill(skill.name)}
                          >
                            <X />
                          </button>
                        </div>
                      );
                    })}
                    {!assignedSkills.length ? <p>No Skills or Plugins assigned.</p> : null}
                    <h3>
                      <span>MCP servers</span>
                      <small>{assignedMcps.length} assigned</small>
                    </h3>
                    {assignedMcps.map((server) => (
                      <div key={server.name} data-ready={server.enabled}>
                        <Server />
                        <span>
                          <strong>{server.name.split(":").at(-1)}</strong>
                          <small>MCP · {server.origin}</small>
                        </span>
                        <small>{mcpState(server)}</small>
                        <button
                          type="button"
                          aria-label={`Remove ${server.name}`}
                          onClick={() => toggleMcp(server.name)}
                        >
                          <X />
                        </button>
                      </div>
                    ))}
                    {!assignedMcps.length ? <p>No MCP servers assigned.</p> : null}
                  </div>
                </section>
              </div>
              <footer className="specialist-snapshot-note">
                <LockKeyhole /> Changes apply to new delegations. Running subagents keep the profile
                and capabilities they started with.
              </footer>
            </div>
          ) : (
            <div className="specialist-editor-empty">
              <Users />
              <p>Create a specialist to define its service levels and capabilities.</p>
              <button type="button" onClick={addSpecialist}>
                <Plus /> New specialist
              </button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
