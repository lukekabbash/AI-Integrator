interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** Renders beside the track and is announced in place of the raw number: a
   * four-stop audience slider reads as "Beginner", not as "0". */
  format: (value: number) => string;
  "aria-label": string;
  /** True when `format` returns words rather than a short numeric reading, so
   * the value gets room instead of wrapping. */
  wide?: boolean;
  disabled?: boolean;
}

/** A labelled range input.
 *
 * The part worth sharing is `aria-valuetext`: several sliders here are an index
 * standing in for a choice, and without it a screen reader announces the index
 * rather than the choice. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  "aria-label": ariaLabel,
  wide = false,
  disabled = false,
}: SliderProps) {
  const text = format(value);
  return (
    <div className="range-control" data-wide={wide || undefined}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={text}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{text}</output>
    </div>
  );
}
