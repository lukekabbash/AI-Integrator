import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface DropdownProps {
  value?: string;
  defaultValue?: string;
  options: DropdownOption[];
  onChange?: (value: string) => void;
  "aria-label": string;
  className?: string;
  leading?: ReactNode;
  compact?: boolean;
}

export function Dropdown({
  value,
  defaultValue,
  options,
  onChange,
  "aria-label": ariaLabel,
  className = "",
  leading,
  compact = false,
}: DropdownProps) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? options[0]?.value ?? "");
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"down" | "up">("down");
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const selectedValue = value ?? internalValue;
  const selected = options.find((option) => option.value === selectedValue) ?? options[0];
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

  const choose = (option: DropdownOption) => {
    if (option.disabled) return;
    setInternalValue(option.value);
    onChange?.(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const focusOption = (index: number) => {
    setHighlighted(index);
    optionRefs.current[index]?.focus();
  };

  const openMenu = () => {
    const triggerRect = buttonRef.current?.getBoundingClientRect();
    if (triggerRect && typeof window !== "undefined") {
      const estimatedMenuHeight = Math.min(options.length * 30 + 12, 320);
      const roomBelow = window.innerHeight - triggerRect.bottom - 12;
      const roomAbove = triggerRect.top - 12;
      setPlacement(roomBelow < estimatedMenuHeight && roomAbove > roomBelow ? "up" : "down");
    }
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.value === selectedValue),
    );
    setHighlighted(selectedIndex);
    setOpen(true);
  };

  // Move focus into the listbox once it is mounted so arrow keys traverse
  // options immediately (the menu does not exist yet inside openMenu).
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      optionRefs.current[highlighted]?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
    // Only refocus when the menu opens, not on every highlight change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`dropdown ${compact ? "dropdown--compact" : ""} ${className}`.trim()}
      data-open={open}
    >
      <button
        ref={buttonRef}
        className="dropdown-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        {leading}
        {/* A leading glyph already identifies the control; stacking the
            selected option's icon next to it reads as a duplicate. */}
        {!leading && selected?.icon ? (
          <span className="dropdown-selected-icon">{selected.icon}</span>
        ) : null}
        <span className="dropdown-label">{selected?.label ?? "Select"}</span>
        <ChevronDown className="dropdown-chevron" aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className={`dropdown-menu dropdown-menu--${placement}`}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            initial={{ opacity: 0, y: -5, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: motionDisabled ? 0 : 0.16, ease: [0.2, 0, 0, 1] }}
          >
            {options.map((option, index) => (
              <button
                className="dropdown-option"
                type="button"
                role="option"
                aria-selected={option.value === selected?.value}
                disabled={option.disabled}
                data-highlighted={highlighted === index}
                key={option.value}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(option)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    choose(option);
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusOption(Math.min(options.length - 1, index + 1));
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    focusOption(Math.max(0, index - 1));
                  }
                  if (event.key === "Home") {
                    event.preventDefault();
                    focusOption(0);
                  }
                  if (event.key === "End") {
                    event.preventDefault();
                    focusOption(options.length - 1);
                  }
                }}
              >
                {option.icon ? <span className="dropdown-option-icon">{option.icon}</span> : null}
                <span>{option.label}</span>
                {option.value === selected?.value ? <Check aria-hidden="true" /> : null}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const PROVIDER_ICON_SOURCES: Record<string, string> = {
  codex: "/brand/providers/openai.png",
  cursor: "/brand/providers/cursor.ico",
  claude: "/brand/providers/anthropic.ico",
  // Antigravity routes to Google's Gemini models; reuse the Gemini glyph
  // until Google publishes a distinct Antigravity mark.
  antigravity: "/brand/providers/gemini.png",
  grok: "/brand/providers/xai.ico",
};

export function ProviderIcon({ provider, label }: { provider: string; label?: string }) {
  const source = PROVIDER_ICON_SOURCES[provider];
  if (!source)
    return (
      <span className="provider-icon provider-icon--fallback">{label?.slice(0, 1) ?? "?"}</span>
    );
  return <img className="provider-icon" src={source} alt="" aria-hidden="true" />;
}
