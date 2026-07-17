// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { insertVoiceText } from "./voiceTyping";

describe("voice typing draft preservation", () => {
  it("inserts transcribed text at the caret without dropping the rest of the draft", () => {
    expect(insertVoiceText("Review this carefully", "please", { start: 11, end: 11 })).toBe(
      "Review this please carefully",
    );
  });

  it("replaces a selection with the transcript", () => {
    expect(insertVoiceText("Review this carefully", "everything", { start: 7, end: 11 })).toBe(
      "Review everything carefully",
    );
  });

  it("keeps an empty draft unchanged when the transcript is empty", () => {
    expect(insertVoiceText("keep me", "", { start: 0, end: 0 })).toBe("keep me");
  });
});
