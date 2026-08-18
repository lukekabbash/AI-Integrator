import { ImageOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { bridge } from "../bridge";

/**
 * A picture inside an agent's reply.
 *
 * An agent that has just photographed a page should be able to hand the person
 * the photograph, not a file path to go and open. The capture already lives in
 * app-owned data, so the reply only has to name it: this reads that file back
 * as a `data:` URL — the renderer's content policy allows those and nothing
 * remote — and draws it.
 *
 * Anything that is not one of this app's own captures is refused by the native
 * side, so a page that talks an agent into writing `![](C:\\secrets\\key.png)`
 * gets a broken-image note rather than a file read. Remote addresses are not
 * fetched at all: the policy forbids them and quietly failing to load would be
 * indistinguishable from the app losing the picture.
 */
export function MarkdownImage({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const address = (src ?? "").trim();
  const inline = address.startsWith("data:");
  const remote = /^(https?|blob):/i.test(address);
  // A reply can swap one picture for another in place, so the resolved bytes
  // are keyed by the address they belong to and dropped the moment it changes
  // — otherwise the previous capture lingers under the new alt text for as
  // long as the read takes.
  const [state, setState] = useState(() => ({ address, url: null as string | null, failed: false }));
  const current = state.address === address ? state : { address, url: null, failed: false };
  if (state.address !== address) setState(current);
  const { url: resolved, failed } = current;
  // Both writes are ignored once the address has moved on, so a slow read for
  // the previous picture cannot paint over the current one.
  const setResolved = useCallback(
    (url: string) =>
      setState((previous) => (previous.address === address ? { ...previous, url } : previous)),
    [address],
  );
  const setFailed = useCallback(
    () =>
      setState((previous) =>
        previous.address === address ? { ...previous, failed: true } : previous,
      ),
    [address],
  );

  // No native side to ask (the web preview) is a fact about this build, not
  // something to discover asynchronously.
  const readable = typeof bridge.browser?.captureImage === "function";

  useEffect(() => {
    if (!address || inline || remote || !readable) return;
    const api = bridge.browser;
    if (!api?.captureImage) return;
    let active = true;
    const local = address.startsWith("file://")
      ? decodeURIComponent(address.replace(/^file:\/\/\/?/, ""))
      : address;
    void api
      .captureImage(local)
      .then((dataUrl) => {
        if (active) setResolved(dataUrl);
      })
      .catch(() => {
        if (active) setFailed();
      });
    return () => {
      active = false;
    };
  }, [address, inline, readable, remote, setFailed, setResolved]);

  if (!address) return null;
  if (remote || failed || (!inline && !readable)) {
    return (
      <span className="markdown-image-missing" title={address}>
        <ImageOff aria-hidden="true" />
        {alt || "Image"}
      </span>
    );
  }
  const source = inline ? address : resolved;
  if (!source) return <span className="markdown-image-pending" aria-hidden="true" />;
  return (
    <img
      className="markdown-image"
      src={source}
      alt={alt || ""}
      title={title || alt || undefined}
      loading="lazy"
      draggable={false}
      onError={() => setFailed()}
    />
  );
}
