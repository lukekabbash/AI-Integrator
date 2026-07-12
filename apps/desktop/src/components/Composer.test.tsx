// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appendVoiceSegment, insertVoiceText } from "./voiceTyping";

describe("voice typing draft preservation", () => {
  it("inserts dictated text at the caret without dropping the rest of the draft", () => {
    expect(insertVoiceText("Review this carefully", "please", { start: 11, end: 11 })).toBe(
      "Review this please carefully",
    );
  });

  it("keeps earlier utterances when a later utterance completes", () => {
    const first = appendVoiceSegment("", "check the auth flow");
    const second = appendVoiceSegment(first, "then update the tests");

    expect(second).toBe("check the auth flow then update the tests");
  });

  it("does not add an extra space when the transcript already carries one", () => {
    expect(appendVoiceSegment("check the auth flow", " then update the tests")).toBe(
      "check the auth flow then update the tests",
    );
  });
});
