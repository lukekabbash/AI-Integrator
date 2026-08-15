import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import { Blocks, Check, ChevronDown } from "lucide-react";
/* Per-schedule tool scope. `undefined` = every globally enabled MCP server
   and skill; a scope narrows that to named entries. Only enabled tools are
   offered — enabling/disabling globally still lives in Settings. Menu motion
   matches Dropdown so the two read as one control family.

   Structurally typed on purpose: the picker stays off the bridge facade and
   accepts the bridge's `IntegratorMcpServer` / `IntegratorSkillInfo` /
   `AutomationToolScope` shapes as-is. */
export interface ToolScopeValue {
  mcpServers: string[];
  skills: string[];
}

interface McpServerLike {
  name: string;
  enabled: boolean;
  origin: string;
}

interface SkillLike {
  name: string;
  enabled: boolean;
  description: string;
}

type AutomationToolScope = ToolScopeValue;
type IntegratorMcpServer = McpServerLike;
type IntegratorSkillInfo = SkillLike;

const menuSpring = { type: "spring" as const, stiffness: 540, damping: 33, mass: 0.7 };

// eslint-disable-next-line react-refresh/only-export-components
export function toolScopeSummary(
  scope: AutomationToolScope | undefined,
  mcps: IntegratorMcpServer[],
  skills: IntegratorSkillInfo[],
): string {
  const enabledMcps = mcps.filter((server) => server.enabled);
  const enabledSkills = skills.filter((skill) => skill.enabled);
  if (!scope) {
    const total = enabledMcps.length + enabledSkills.length;
    return total ? `All enabled tools · ${total}` : "All enabled tools";
  }
  const mcpCount = scope.mcpServers.filter((name) =>
    enabledMcps.some((server) => server.name === name),
  ).length;
  const skillCount = scope.skills.filter((name) =>
    enabledSkills.some((skill) => skill.name === name),
  ).length;
  if (!mcpCount && !skillCount) return "No tools";
  const parts = [];
  if (mcpCount) parts.push(`${mcpCount} MCP${mcpCount === 1 ? "" : "s"}`);
  if (skillCount) parts.push(`${skillCount} skill${skillCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function shortSkillName(name: string): string {
  const index = name.lastIndexOf(":");
  return index >= 0 ? name.slice(index + 1) : name;
}

export function ToolScopePicker({
  value,
  mcps,
  skills,
  onChange,
  "aria-label": ariaLabel,
  className = "",
  loading = false,
}: {
  value: AutomationToolScope | undefined;
  mcps: IntegratorMcpServer[];
  skills: IntegratorSkillInfo[];
  onChange: (scope: AutomationToolScope | undefined) => void;
  "aria-label": string;
  className?: string;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"down" | "up">("down");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const enabledMcps = mcps.filter((server) => server.enabled);
  const enabledSkills = skills.filter((skill) => skill.enabled);
  const restricted = value !== undefined;
  const motionDisabled =
    typeof document !== "undefined" &&
    (document.documentElement.dataset.motion === "none" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const setRestricted = (next: boolean) => {
    if (!next) {
      onChange(undefined);
      return;
    }
    // Start from everything enabled so the user unchecks rather than rebuilds.
    onChange({
      mcpServers: enabledMcps.map((server) => server.name),
      skills: enabledSkills.map((skill) => skill.name),
    });
  };

  const toggle = (kind: "mcpServers" | "skills", name: string) => {
    if (!value) return;
    const list = value[kind];
    const next = list.includes(name) ? list.filter((item) => item !== name) : [...list, name];
    onChange({ ...value, [kind]: next });
  };

  const summary = loading ? "Loading tools…" : toolScopeSummary(value, mcps, skills);

  return (
    <div
      ref={rootRef}
      className={`dropdown tool-scope ${className}`.trim()}
      data-open={open}
      data-restricted={restricted}
    >
      <button
        ref={buttonRef}
        className="dropdown-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          // Same auto-flip as Dropdown: open upward when the rail runs out of room.
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect && typeof window !== "undefined") {
            const roomBelow = window.innerHeight - rect.bottom - 12;
            const roomAbove = rect.top - 12;
            setPlacement(roomBelow < 360 && roomAbove > roomBelow ? "up" : "down");
          }
          setOpen(true);
        }}
      >
        <Blocks className="tool-scope-glyph" aria-hidden="true" />
        <span className="dropdown-label">{summary}</span>
        <ChevronDown className="dropdown-chevron" aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className={`dropdown-menu dropdown-menu--${placement} tool-scope-menu`}
            id={menuId}
            role="dialog"
            aria-label={ariaLabel}
            initial={{ opacity: 0, y: placement === "up" ? 6 : -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{
              opacity: 0,
              y: placement === "up" ? 4 : -4,
              scale: 0.98,
              transition: { duration: motionDisabled ? 0 : 0.12, ease: [0.2, 0, 0, 1] },
            }}
            transition={motionDisabled ? { duration: 0 } : menuSpring}
          >
            <label className="tool-scope-mode">
              <span>
                <strong>Use every enabled tool</strong>
                <small>Follows Settings; new tools you enable join automatically.</small>
              </span>
              <button
                className="switch"
                type="button"
                role="switch"
                aria-label="Use every enabled tool"
                aria-checked={!restricted}
                data-checked={!restricted}
                onClick={() => setRestricted(restricted ? false : true)}
              >
                <span />
              </button>
            </label>
            <div className="tool-scope-groups" data-disabled={!restricted}>
              <ToolGroup
                title="MCP servers"
                empty="No MCP servers are enabled."
                items={enabledMcps.map((server) => ({
                  name: server.name,
                  label: server.name,
                  detail: server.origin,
                }))}
                selected={value?.mcpServers ?? enabledMcps.map((server) => server.name)}
                disabled={!restricted}
                onToggle={(name) => toggle("mcpServers", name)}
              />
              <ToolGroup
                title="Skills"
                empty="No skills are enabled."
                items={enabledSkills.map((skill) => ({
                  name: skill.name,
                  label: shortSkillName(skill.name),
                  detail: skill.description,
                }))}
                selected={value?.skills ?? enabledSkills.map((skill) => skill.name)}
                disabled={!restricted}
                onToggle={(name) => toggle("skills", name)}
              />
            </div>
            <p className="tool-scope-footnote">
              Only tools enabled in Settings are offered. Disabling one there removes it from every
              schedule.
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ToolGroup({
  title,
  empty,
  items,
  selected,
  disabled,
  onToggle,
}: {
  title: string;
  empty: string;
  items: { name: string; label: string; detail?: string }[];
  selected: string[];
  disabled: boolean;
  onToggle: (name: string) => void;
}) {
  return (
    <section className="tool-scope-group" aria-label={title}>
      <header>
        <span>{title}</span>
        <small>
          {items.length
            ? `${selected.filter((n) => items.some((i) => i.name === n)).length}/${items.length}`
            : ""}
        </small>
      </header>
      {items.length ? (
        items.map((item) => {
          const checked = selected.includes(item.name);
          return (
            <button
              key={item.name}
              className="tool-scope-option"
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={item.label}
              disabled={disabled}
              data-checked={checked}
              onClick={() => onToggle(item.name)}
            >
              <span className="tool-scope-box" aria-hidden="true">
                {checked ? <Check /> : null}
              </span>
              <span className="tool-scope-copy">
                <strong>{item.label}</strong>
                {item.detail ? <small>{item.detail}</small> : null}
              </span>
            </button>
          );
        })
      ) : (
        <p className="tool-scope-empty">{empty}</p>
      )}
    </section>
  );
}
