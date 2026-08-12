import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { FileIcon } from "./FileIcon";
import { Tooltip } from "./Tooltip";

interface TitlebarFileTab {
  path: string;
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function TitlebarFileTabs({
  tabs,
  activePath,
  onSelect,
  onClose,
}: {
  tabs: TitlebarFileTab[];
  activePath: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const activeTabRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const activeTab = activeTabRef.current;
    if (!activeTab) return;
    const revealActiveTab = () =>
      activeTab.scrollIntoView?.({ behavior: "auto", block: "nearest", inline: "nearest" });
    revealActiveTab();
    const strip = activeTab.parentElement;
    const observer =
      strip && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(revealActiveTab)
        : undefined;
    if (strip) observer?.observe(strip);
    window.addEventListener("resize", revealActiveTab);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", revealActiveTab);
    };
  }, [activePath]);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.currentTarget.scrollWidth <= event.currentTarget.clientWidth ||
      (event.target as HTMLElement).closest(".file-reader-tab-close")
    ) {
      return;
    }
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: event.currentTarget.scrollLeft,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const delta = event.clientX - pan.startX;
    if (!pan.moved && Math.abs(delta) < 4) return;
    pan.moved = true;
    suppressClickRef.current = true;
    event.currentTarget.dataset.dragging = "true";
    event.currentTarget.scrollLeft = pan.startScrollLeft - delta;
    event.preventDefault();
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    delete event.currentTarget.dataset.dragging;
    panRef.current = null;
    if (pan.moved) {
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  };

  return (
    <div
      className="titlebar-file-tabs"
      role="tablist"
      aria-label="Open files"
      onPointerDown={beginPan}
      onPointerMove={movePan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      {tabs.map((tab) => {
        const name = fileName(tab.path);
        const active = tab.path === activePath;
        return (
          <div
            className="file-reader-tab"
            data-active={active}
            key={tab.path}
            ref={active ? activeTabRef : undefined}
          >
            <Tooltip label={tab.path} placement="bottom">
              <button
                type="button"
                role="tab"
                aria-label={name}
                aria-selected={active}
                onClick={(event) => {
                  if (suppressClickRef.current) {
                    event.preventDefault();
                    return;
                  }
                  onSelect(tab.path);
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    onClose(tab.path);
                  }
                }}
              >
                <FileIcon fileName={tab.path} />
                <span>{name}</span>
              </button>
            </Tooltip>
            <button
              className="file-reader-tab-close"
              type="button"
              aria-label={`Close ${tab.path}`}
              onClick={() => onClose(tab.path)}
            >
              <X />
            </button>
          </div>
        );
      })}
    </div>
  );
}
