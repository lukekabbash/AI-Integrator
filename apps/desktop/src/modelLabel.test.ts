import { describe, expect, it } from "vitest";
import { prettyModelLabel, resolveModelLabel } from "./modelLabel";

describe("prettyModelLabel", () => {
  it("pretty-prints common wire ids across runtimes", () => {
    expect(prettyModelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(prettyModelLabel("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(prettyModelLabel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(prettyModelLabel("gpt-5.4")).toBe("GPT-5.4");
    expect(prettyModelLabel("gpt-5-mini")).toBe("GPT-5 mini");
    expect(prettyModelLabel("gpt-5-codex")).toBe("GPT-5 Codex");
    expect(prettyModelLabel("gpt-oss-120b")).toBe("GPT-OSS 120B");

    expect(prettyModelLabel("grok-4.5")).toBe("Grok 4.5");
    expect(prettyModelLabel("grok-build-0.1")).toBe("Grok Build 0.1");

    expect(prettyModelLabel("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
    expect(prettyModelLabel("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(prettyModelLabel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(prettyModelLabel("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(prettyModelLabel("claude-fable-5")).toBe("Claude Fable 5");

    expect(prettyModelLabel("composer-2.5")).toBe("Composer 2.5");
    expect(prettyModelLabel("cursor-small")).toBe("Cursor Small");
    expect(prettyModelLabel("deepseek-r1")).toBe("DeepSeek R1");
    expect(prettyModelLabel("deepseek-v3.1")).toBe("DeepSeek V3.1");
    expect(prettyModelLabel("auto")).toBe("Auto");
  });

  it("leaves already-pretty names alone", () => {
    expect(prettyModelLabel("Gemini 3.1 Pro")).toBe("Gemini 3.1 Pro");
    expect(prettyModelLabel("GPT-5.4")).toBe("GPT-5.4");
    expect(prettyModelLabel("Composer 2.5")).toBe("Composer 2.5");
    expect(prettyModelLabel("Claude Sonnet 4.6 (Thinking)")).toBe(
      "Claude Sonnet 4.6 (Thinking)",
    );
    expect(prettyModelLabel("GPT-OSS 120B")).toBe("GPT-OSS 120B");
  });

  it("strips Cursor bracketed config from display labels", () => {
    expect(prettyModelLabel("gpt-5.5[reasoning=medium,context=272k]")).toBe("GPT-5.5");
    expect(
      prettyModelLabel("claude-opus-4-8[thinking=true,context=300k,effort=high]"),
    ).toBe("Claude Opus 4.8");
  });

  it("handles empty and placeholder values", () => {
    expect(prettyModelLabel(undefined)).toBe("");
    expect(prettyModelLabel(null)).toBe("");
    expect(prettyModelLabel("")).toBe("");
    expect(prettyModelLabel("Provider default")).toBe("");
  });
});

describe("resolveModelLabel", () => {
  it("prefers a distinct provider display name", () => {
    expect(resolveModelLabel("gpt-5.4", "GPT-5.4")).toBe("GPT-5.4");
    expect(resolveModelLabel("composer-2.5", "Composer 2.5")).toBe("Composer 2.5");
    expect(resolveModelLabel("default", "Auto")).toBe("Auto");
    expect(resolveModelLabel("claude-opus-4-8", "Opus 4.8")).toBe("Opus 4.8");
  });

  it("pretty-prints when the provider label is missing or equal to the wire id", () => {
    expect(resolveModelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(resolveModelLabel("gpt-5.6-sol", "gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(resolveModelLabel("grok-4.5", "")).toBe("Grok 4.5");
    expect(resolveModelLabel("grok-4.5", null)).toBe("Grok 4.5");
  });
});
