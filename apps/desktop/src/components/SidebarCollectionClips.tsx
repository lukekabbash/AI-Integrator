import { useEffect, useRef, useState, type ReactNode } from "react";

/** Matches the grid-template-rows transition in the sidebar stylesheet. */
const PROJECT_CHAT_LIST_CLIP_MS = 220;

function afterNextPaint(callback: () => void) {
  let secondFrame = 0;
  const firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(callback);
  });
  return () => {
    window.cancelAnimationFrame(firstFrame);
    if (secondFrame) window.cancelAnimationFrame(secondFrame);
  };
}

/** CSS grid 0fr/1fr clip that avoids measuring animated auto heights. */
export function ProjectChatListClip({
  open,
  menuOpen,
  reduceMotion,
  children,
}: {
  open: boolean;
  menuOpen: boolean;
  reduceMotion: boolean;
  children: () => ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [clipOpen, setClipOpen] = useState(open);
  const previousOpen = useRef(open);

  useEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    if (open) {
      // The closed frame must mount before the next-paint transition begins.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      if (reduceMotion) {
        setClipOpen(true);
        return;
      }
      setClipOpen(false);
      return afterNextPaint(() => setClipOpen(true));
    }
    setClipOpen(false);
    if (reduceMotion) {
      setMounted(false);
      return;
    }
    // Safety if transitionend is skipped, for example when hidden mid-flight.
    const timer = window.setTimeout(() => setMounted(false), PROJECT_CHAT_LIST_CLIP_MS + 40);
    return () => window.clearTimeout(timer);
  }, [open, reduceMotion]);

  if (!mounted) return null;

  return (
    <div
      className="project-chat-list-clip"
      data-open={clipOpen ? "true" : "false"}
      data-menu-open={menuOpen ? "true" : "false"}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== "grid-template-rows") return;
        if (!open) setMounted(false);
      }}
    >
      <div className="project-chat-list-inner">
        <div className="project-chat-list" data-menu-open={menuOpen ? "true" : "false"}>
          {children()}
        </div>
      </div>
    </div>
  );
}

export function SidebarCollectionClip({
  open,
  reduceMotion,
  children,
}: {
  open: boolean;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [clipOpen, setClipOpen] = useState(open);
  const previousOpen = useRef(open);

  useEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    if (open) {
      // The closed frame must mount before the next-paint transition begins.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      if (reduceMotion) {
        setClipOpen(true);
        return;
      }
      setClipOpen(false);
      return afterNextPaint(() => setClipOpen(true));
    }
    setClipOpen(false);
    if (reduceMotion) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), PROJECT_CHAT_LIST_CLIP_MS + 40);
    return () => window.clearTimeout(timer);
  }, [open, reduceMotion]);

  if (!mounted) return null;

  return (
    <div
      className="sidebar-collection-clip"
      data-open={clipOpen ? "true" : "false"}
      data-reduce-motion={reduceMotion ? "true" : undefined}
      aria-hidden={!open}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") {
          return;
        }
        if (!open) setMounted(false);
      }}
    >
      <div className="sidebar-collection-clip-inner">{children}</div>
    </div>
  );
}
