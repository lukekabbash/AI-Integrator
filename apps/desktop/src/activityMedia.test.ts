import { describe, expect, it } from "vitest";

import { extractActivityImages, isImageFileName, outputLooksLikeImage } from "./activityMedia";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("activity screenshot media", () => {
  it("recognises image file names and screenshot-shaped output", () => {
    expect(isImageFileName("/tmp/Annotation · Sign in.png")).toBe(true);
    expect(isImageFileName("src/App.tsx")).toBe(false);
    expect(outputLooksLikeImage(`{"type":"image","data":"${PNG}"}`)).toBe(true);
    expect(outputLooksLikeImage("fn main() {}")).toBe(false);
  });

  it("lifts an MCP image block out of Codex tool output", () => {
    const output = JSON.stringify(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ width: 1280, height: 800, note: "a picture of the tab" }),
          },
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
        isError: false,
      },
      null,
      2,
    );
    const media = extractActivityImages(output);
    expect(media.images).toEqual([`data:image/png;base64,${PNG}`]);
    expect(media.text).toContain("1280");
    expect(media.text).toContain("a picture of the tab");
    expect(media.text).not.toContain(PNG);
    expect(media.text).not.toContain("image/png");
  });

  it("keeps a saved capture path so the transcript can load the file", () => {
    const media = extractActivityImages(
      JSON.stringify({
        width: 800,
        imagePath: "H:/app/browser-captures/task-1/screenshot.png",
        note: "on screen",
      }),
    );
    expect(media.imagePaths).toEqual(["H:/app/browser-captures/task-1/screenshot.png"]);
    expect(media.text).toContain("screenshot.png");
  });

  it("hides a truncated base64 wall instead of showing it as prose", () => {
    const media = extractActivityImages(
      `{"content":[{"type":"image","data":"iVBORw0KGgoAAAANSUhEUgAA${"A".repeat(80)}","mimeType":"image/png"}]}\n[truncated]`,
    );
    expect(media.images).toEqual([]);
    expect(media.text).not.toContain("iVBORw0KGgo");
    expect(media.text).not.toContain("[truncated]");
  });

  it("recovers a saved path from a truncated Codex tool dump", () => {
    const media = extractActivityImages(
      `{\n  "content": [\n    {\n      "type": "text",\n      "text": "{\\n  \\"imagePath\\": \\"H:\\\\app\\\\browser-captures\\\\task-1\\\\shot.png\\"\\n}"\n    },\n    {\n      "type": "image",\n      "data": "iVBORw0KGgoAAAANSUhEUgAA${"A".repeat(80)}"\n[truncated]`,
    );
    expect(media.imagePaths).toEqual(["H:\\app\\browser-captures\\task-1\\shot.png"]);
    expect(media.images).toEqual([]);
  });
});
