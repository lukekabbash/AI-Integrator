import { describe, expect, it } from "vitest";

import {
  annotationAttachmentLabel,
  annotationAttachmentName,
  annotationImageNames,
  isAnnotationAttachment,
  isAnnotationBlock,
  pairAnnotationAttachments,
  parseAnnotationBlock,
  splitAnnotationBlocks,
  ANNOTATION_ATTACHMENT_PREFIX,
} from "./browserAnnotation";

const BLOCK = [
  "<browser_annotation>",
  "Page: T3 Code (Alpha)",
  "URL: http://localhost:3773/pair",
  'Element: <p> role=paragraph name="Pair with this environment"',
  "Selector: #root > div > section > p:nth-of-type(1)",
  "</browser_annotation>",
].join("\n");

describe("browser annotation attachments", () => {
  it("names an annotation after the element it marks", () => {
    expect(annotationAttachmentName("Sign in")).toBe("Annotation · Sign in.png");
    expect(annotationAttachmentName("  Buy   now  ")).toBe("Annotation · Buy now.png");
  });

  it("keeps a page's own text out of the file name", () => {
    // A page controls this label, so path separators and Windows-illegal
    // characters must not survive into a file name.
    expect(annotationAttachmentName("reports/2026: q1?")).toBe("Annotation · reports 2026 q1.png");
    expect(annotationAttachmentName("   ")).toBe("Annotation · page.png");
  });

  it("tells an annotation block from ordinary prose", () => {
    expect(isAnnotationBlock(BLOCK)).toBe(true);
    expect(isAnnotationBlock(`${BLOCK}\n`)).toBe(true);
    expect(isAnnotationBlock("look at <browser_annotation> in the docs")).toBe(false);
    expect(isAnnotationBlock("@src/App.tsx")).toBe(false);
  });

  it("reads a block back into what the chip shows", () => {
    const parsed = parseAnnotationBlock(BLOCK, 3);
    expect(parsed).toMatchObject({
      id: 3,
      label: "Pair with this environment",
      origin: "localhost:3773",
      note: "",
    });
    // The chip is a view; the block itself must survive untouched for the agent.
    expect(parsed.raw).toBe(BLOCK);
  });

  it("keeps the note the user typed beside the element", () => {
    const withNote = BLOCK.replace(
      "</browser_annotation>",
      "Note:\nmake this a button\n</browser_annotation>",
    );
    expect(parseAnnotationBlock(withNote, 1).note).toBe("make this a button");
  });

  it("falls back to the tag when the element has no accessible name", () => {
    const unnamed = BLOCK.replace(' name="Pair with this environment"', "");
    expect(parseAnnotationBlock(unnamed, 1).label).toBe("<p>");
  });

  it("recognises exactly what it produced, and nothing else", () => {
    expect(isAnnotationAttachment(annotationAttachmentName("Header"))).toBe(true);
    expect(isAnnotationAttachment("screenshot.png")).toBe(false);
    expect(isAnnotationAttachment("annotation · header.png")).toBe(false);
    expect(ANNOTATION_ATTACHMENT_PREFIX.endsWith(" ")).toBe(true);
  });

  it("reads the element back out of an annotation file name", () => {
    expect(annotationAttachmentLabel("Annotation · Sign in.png")).toBe("Sign in");
    expect(annotationAttachmentLabel("screenshot.png")).toBe("screenshot.png");
  });

  it("pairs an annotation with the screenshot named after it", () => {
    const named = parseAnnotationBlock(BLOCK, 1);
    const unnamed = parseAnnotationBlock(
      BLOCK.replace(' name="Pair with this environment"', ""),
      2,
    );
    expect(annotationImageNames(named)).toEqual(["Annotation · Pair with this environment.png"]);
    expect(annotationImageNames(unnamed)).toEqual(["Annotation · p.png"]);

    const crop = { name: "Annotation · Pair with this environment.png" };
    const other = { name: "browser-1.png" };
    const pairs = pairAnnotationAttachments([named], [other, crop]);
    expect(pairs.get(1)).toBe(crop);
    expect(pairs.size).toBe(1);
  });

  it("pairs a lone annotation image when the names only agree on the tag", () => {
    const unnamed = parseAnnotationBlock(
      BLOCK.replace(' name="Pair with this environment"', ""),
      4,
    );
    const crop = { name: "Annotation · p.png" };
    expect(pairAnnotationAttachments([unnamed], [crop]).get(4)).toBe(crop);
  });

  it("lifts annotation blocks out of a sent prompt", () => {
    const sent = `please restyle this\n\n${BLOCK}`;
    const { text, annotations } = splitAnnotationBlocks(sent);
    expect(text).toBe("please restyle this");
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      label: "Pair with this environment",
      origin: "localhost:3773",
    });
    expect(splitAnnotationBlocks("just text")).toEqual({ text: "just text", annotations: [] });
  });
});
