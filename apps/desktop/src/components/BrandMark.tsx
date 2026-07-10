export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand-lockup" aria-label="AI Integrator">
      <span className="brand-mark-frame" aria-hidden="true">
        <img src="/brand/ai-integrator-mark-light.png" alt="" />
      </span>
      {!compact ? <span className="brand-name">AI Integrator</span> : null}
    </span>
  );
}
