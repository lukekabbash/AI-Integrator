import { describe, expect, it } from "vitest";

import {
  annotationAttachmentName,
  isAnnotationAttachment,
  ANNOTATION_ATTACHMENT_PREFIX,
} from "./browserAnnotation";

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

  it("recognises exactly what it produced, and nothing else", () => {
    expect(isAnnotationAttachment(annotationAttachmentName("Header"))).toBe(true);
    expect(isAnnotationAttachment("screenshot.png")).toBe(false);
    expect(isAnnotationAttachment("annotation · header.png")).toBe(false);
    expect(ANNOTATION_ATTACHMENT_PREFIX.endsWith(" ")).toBe(true);
  });
});
