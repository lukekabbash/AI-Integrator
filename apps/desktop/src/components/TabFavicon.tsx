import { Globe } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * A tab's site icon, with the globe as its fallback.
 *
 * The native side hands these over as `data:` URLs — the renderer's content
 * policy allows no remote images, and fetching them in the app process keeps
 * the page from seeing a request from this window. Anything that fails to
 * decode falls back to the glyph the strip used before there were icons, so a
 * broken image never leaves a hole where the tab's mark should be.
 */
export function TabFavicon({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <Globe aria-hidden="true" />;
  return (
    <img
      className="tab-favicon"
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
