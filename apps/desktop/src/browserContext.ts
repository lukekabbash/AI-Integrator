/** The bounded page data the native browser has already authenticated. */
export interface BrowserContextPayload {
  pageTitle?: string;
  pageUrl: string;
  targetUrl?: string;
  text?: string;
}

/** Untrusted page context stays visibly data, never executable prompt markup. */
export function browserContextComposerText(request: BrowserContextPayload): string {
  const payload = JSON.stringify(
    {
      pageTitle: request.pageTitle || undefined,
      pageUrl: request.pageUrl,
      linkUrl:
        request.targetUrl && request.targetUrl !== request.pageUrl ? request.targetUrl : undefined,
      selectedText: request.text || undefined,
    },
    null,
    2,
  )
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `<browser_context>\n${payload}\n</browser_context>\n`;
}
