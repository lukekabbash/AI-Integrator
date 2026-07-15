import { useRef, useState } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import { ArrowUp, CornerDownLeft, GripVertical, Loader2, X } from "lucide-react";
import { Tooltip } from "./Tooltip";

export interface QueuedMessage {
  id: string;
  prompt: string;
}

interface QueuedMessagesProps {
  messages: QueuedMessage[];
  /** Dispatches this queued message immediately. */
  onSendNow: (id: string) => void;
  /** Removes the message from the queue and restores it as the editable draft. */
  onReturnToComposer: (id: string) => void;
  /** Permanently removes the message from the queue. */
  onDelete: (id: string) => void;
  /** Receives the complete id order after a drag or keyboard move. */
  onReorder: (orderedIds: string[]) => void;
  /** Message currently being dispatched; its actions lock while it settles. */
  busyId?: string;
  disabled?: boolean;
}

/** One line of preview text; the full prompt stays in the title and labels. */
function summarize(prompt: string): string {
  const line = prompt.trim().split("\n", 1)[0];
  return line || prompt.trim();
}

function movedOrder(messages: QueuedMessage[], from: number, to: number): string[] {
  const ids = messages.map((message) => message.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(to, ids.length)), 0, moved);
  return ids;
}

type ExitDirection = "up" | "down" | "discard";

const dropletSpring = { type: "spring", stiffness: 540, damping: 32, mass: 0.7 } as const;

/** Rows grow into the joined timer surface from its lower-right edge. */
const joinedRowVariants = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: dropletSpring },
  exit: (direction: ExitDirection) => {
    const movement =
      direction === "down" ? { y: 12 } : direction === "discard" ? { x: 8 } : { y: -8 };
    return {
      opacity: 0,
      scale: direction === "down" ? 0.9 : 0.96,
      ...movement,
      transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as const },
    };
  },
};

const staticVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0 } },
  exit: () => ({ opacity: 0, transition: { duration: 0 } }),
};

/** Joined stack of pending follow-up messages attached to the composer.
 *  Purely presentational: owners hold the queue and receive
 *  send-now / return / delete / reorder intents. */
export function QueuedMessages({
  messages,
  onSendNow,
  onReturnToComposer,
  onDelete,
  onReorder,
  busyId,
  disabled = false,
}: QueuedMessagesProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Exit direction per message id, recorded at click time so the leave
  // animation matches the intent (send climbs, return-to-composer falls).
  const [exitDirections, setExitDirections] = useState<Record<string, ExitDirection>>({});
  const motionDisabled =
    typeof document !== "undefined" &&
    (document.documentElement.dataset.motion === "none" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  if (messages.length === 0) return null;

  const finishDrag = () => {
    setDragId(null);
    setDropIndex(null);
  };

  const dropAt = (index: number) => {
    if (disabled || dragId === null) return;
    const from = messages.findIndex((message) => message.id === dragId);
    finishDrag();
    if (from < 0 || from === index) return;
    onReorder(movedOrder(messages, from, index));
  };

  const moveByKeyboard = (from: number, to: number) => {
    if (disabled || to < 0 || to >= messages.length) return;
    onReorder(movedOrder(messages, from, to));
  };

  const variants = motionDisabled ? staticVariants : joinedRowVariants;

  return (
    <div
      ref={listRef}
      className="queued-messages"
      role="list"
      aria-label={`Queued messages (${messages.length})`}
    >
      <AnimatePresence initial={false}>
        {messages.map((message, index) => {
          const preview = summarize(message.prompt);
          const busy = busyId === message.id;
          const locked = disabled || busy;
          return (
            <motion.div
              key={message.id}
              role="listitem"
              className="queued-message"
              aria-label={`Queued message ${index + 1} of ${messages.length}: ${message.prompt}`}
              data-dragging={dragId === message.id || undefined}
              data-drop-target={dropIndex === index || undefined}
              data-busy={busy || undefined}
              draggable={!locked}
              // Capture-phase handlers keep the native DragEvent type; Motion
              // rewrites onDragStart/onDragEnd into its pan-gesture callbacks.
              onDragStartCapture={(event) => {
                if (locked) return;
                setDragId(message.id);
                event.dataTransfer?.setData("text/plain", message.id);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (disabled || dragId === null) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                setDropIndex(index);
              }}
              onDragLeave={() => {
                setDropIndex((current) => (current === index ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropAt(index);
              }}
              onDragEndCapture={finishDrag}
              layout={motionDisabled ? false : true}
              custom={exitDirections[message.id] ?? "up"}
              variants={variants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={motionDisabled ? { duration: 0 } : dropletSpring}
            >
              {messages.length > 1 ? (
                <Tooltip label="Reorder queued message" hint="Drag or use ↑/↓">
                  <button
                    className="queued-message-grip"
                    type="button"
                    disabled={locked}
                    aria-label={`Reorder queued message ${index + 1} of ${messages.length}: ${message.prompt}. Press arrow up or arrow down to move.`}
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                      event.preventDefault();
                      moveByKeyboard(index, event.key === "ArrowUp" ? index - 1 : index + 1);
                    }}
                  >
                    <GripVertical aria-hidden="true" />
                  </button>
                </Tooltip>
              ) : (
                <span className="queued-message-marker" aria-hidden="true">
                  <GripVertical />
                </span>
              )}
              <Tooltip label={message.prompt}>
                <span className="queued-message-text" aria-hidden="true">
                  {preview}
                </span>
              </Tooltip>
              {busy ? (
                <span className="queued-message-busy" role="status" aria-label="Sending">
                  <Loader2 aria-hidden="true" />
                </span>
              ) : null}
              <span className="queued-message-actions">
                <Tooltip label="Send now">
                  <button
                    className="queued-message-action"
                    type="button"
                    disabled={locked}
                    aria-label={`Send now: ${message.prompt}`}
                    onClick={() => {
                      setExitDirections((current) => ({ ...current, [message.id]: "up" }));
                      onSendNow(message.id);
                    }}
                  >
                    <ArrowUp aria-hidden="true" />
                  </button>
                </Tooltip>
                <Tooltip label="Return to composer">
                  <button
                    className="queued-message-action"
                    type="button"
                    disabled={locked}
                    aria-label={`Edit in composer: ${message.prompt}`}
                    onClick={() => {
                      setExitDirections((current) => ({ ...current, [message.id]: "down" }));
                      onReturnToComposer(message.id);
                    }}
                  >
                    <CornerDownLeft aria-hidden="true" />
                  </button>
                </Tooltip>
                <Tooltip label="Remove from queue">
                  <button
                    className="queued-message-action"
                    type="button"
                    disabled={locked}
                    aria-label={`Remove from queue: ${message.prompt}`}
                    onClick={() => {
                      setExitDirections((current) => ({ ...current, [message.id]: "discard" }));
                      onDelete(message.id);
                    }}
                  >
                    <X aria-hidden="true" />
                  </button>
                </Tooltip>
              </span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
