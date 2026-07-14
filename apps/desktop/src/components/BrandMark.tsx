export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand-lockup" aria-label="AI Integrator">
      <span className="brand-mark-frame" aria-hidden="true">
        <span className="brand-mark-glyph" />
      </span>
      {!compact ? <span className="brand-name">AI Integrator</span> : null}
    </span>
  );
}
