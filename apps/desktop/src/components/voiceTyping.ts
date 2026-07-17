export interface VoiceInsertAnchor {
  start: number;
  end: number;
}

export function insertVoiceText(
  base: string,
  transcript: string,
  anchor: VoiceInsertAnchor,
): string {
  if (!transcript) return base;
  const start = Math.max(0, Math.min(anchor.start, base.length));
  const end = Math.max(start, Math.min(anchor.end, base.length));
  const before = base.slice(0, start);
  const after = base.slice(end);
  const separator = before && !/\s$/.test(before) && !/^\s/.test(transcript) ? " " : "";
  return `${before}${separator}${transcript}${after}`;
}
