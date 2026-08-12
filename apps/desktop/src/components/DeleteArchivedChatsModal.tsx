import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import { Archive, X } from "lucide-react";
import type { ProjectSummary } from "../bridge";
import { Tooltip } from "./Tooltip";

interface DeleteArchivedChatsModalProps {
  project: ProjectSummary | null;
  chatCount: number;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}

/** Confirms bulk deletion of a live project's archived chats. The project
 * itself is untouched — full-project deletion keeps its own scoped modal. */
export function DeleteArchivedChatsModal({
  project,
  chatCount,
  busy,
  error,
  onClose,
  onConfirm,
}: DeleteArchivedChatsModalProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const projectId = project?.id ?? "";

  useEffect(() => {
    if (!projectId) return;
    confirmRef.current?.focus();
  }, [projectId]);

  const countLabel = `${chatCount} archived chat${chatCount === 1 ? "" : "s"}`;

  const modal = (
    <AnimatePresence>
      {project ? (
        <motion.div
          className="delete-project-backdrop"
          role="presentation"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.16 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) onClose();
          }}
        >
          <motion.section
            className="delete-project-modal delete-chat-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={reduceMotion ? false : { opacity: 0, y: -12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.99 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 460, damping: 36, mass: 0.75 }
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (!busy) onClose();
                return;
              }
              if (event.key !== "Tab") return;
              const focusable = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"),
              );
              const first = focusable[0];
              const last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <header className="delete-project-header">
              <h2 id={titleId}>Delete archived chats</h2>
              <Tooltip label="Close">
                <button
                  className="delete-project-close"
                  type="button"
                  aria-label="Close"
                  onClick={onClose}
                  disabled={busy}
                >
                  <X aria-hidden="true" />
                </button>
              </Tooltip>
            </header>

            <Tooltip label={project.path} placement="top">
              <div className="delete-project-target">
                <Archive aria-hidden="true" />
                <span className="delete-project-target-copy">
                  <strong>{project.name}</strong>
                  <small>{countLabel}</small>
                </span>
              </div>
            </Tooltip>

            <p className="delete-project-consequence" data-tone="danger" role="status">
              Permanently removes {countLabel} from AI Integrator. The project, its live chats, and
              the folder on disk are untouched.
            </p>

            {error ? (
              <p className="delete-project-error" role="alert">
                {error}
              </p>
            ) : null}

            <footer className="delete-project-footer">
              <button
                type="button"
                className="delete-project-cancel"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                className="delete-project-confirm"
                data-scope="disk"
                disabled={busy || chatCount === 0}
                onClick={onConfirm}
              >
                {busy ? "Deleting…" : `Delete ${countLabel}`}
              </button>
            </footer>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  if (typeof document === "undefined") return modal;
  return createPortal(modal, document.body);
}
