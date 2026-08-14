import type { ReactNode } from "react";

export function SettingRow({
  label,
  description,
  icon,
  children,
}: {
  label: string;
  description: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="setting-row" data-has-icon={icon ? true : undefined}>
      {icon ? (
        <span className="setting-row-icon" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      className="switch"
      type="button"
      role="switch"
      disabled={disabled}
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      data-checked={checked}
    >
      <span />
    </button>
  );
}
