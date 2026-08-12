import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import { Check, Folder, History, Trash2, X } from "lucide-react";
import type { ProjectSummary } from "../bridge";
import { Tooltip } from "./Tooltip";

export type DeleteProjectScope = "history" | "disk";

interface DeleteProjectModalProps {
  project: ProjectSummary | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (scope: DeleteProjectScope) => void;
}

export function DeleteProjectModal({
  project,
  busy,
  error,
  onClose,
  onConfirm,
}: DeleteProjectModalProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");
  const titleId = useId();
  const [scope, setScope] = useState<DeleteProjectScope>("history");
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const projectId = project?.id ?? "";

  useEffect(() => {
    if (!projectId) return;
    setScope("history");
    firstOptionRef.current?.focus();
  }, [projectId]);

  const confirmLabel =
    scope === "history" ? "Remove from AI Integrator" : "Delete folder permanently";

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
            className="delete-project-modal"
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
              <h2 id={titleId}>Remove project</h2>
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
                <Folder aria-hidden="true" />
                <span className="delete-project-target-copy">
                  <strong>{project.name}</strong>
                  <code>{project.path}</code>
                </span>
              </div>
            </Tooltip>

            <div className="delete-project-options" role="radiogroup" aria-label="Deletion scope">
              <button
                ref={firstOptionRef}
                type="button"
                role="radio"
                aria-checked={scope === "history"}
                className="delete-project-option"
                data-selected={scope === "history" ? "true" : "false"}
                data-tone="safe"
                disabled={busy}
                onClick={() => setScope("history")}
              >
                <History aria-hidden="true" />
                <span className="delete-project-option-copy">
                  <strong>Remove chats &amp; history</strong>
                  <small>Deletes conversations and local state. Keeps the folder on disk.</small>
                </span>
                {scope === "history" ? (
                  <Check className="delete-project-check" aria-hidden="true" />
                ) : null}
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={scope === "disk"}
                className="delete-project-option"
                data-selected={scope === "disk" ? "true" : "false"}
                data-tone="danger"
                disabled={busy}
                onClick={() => setScope("disk")}
              >
                <Trash2 aria-hidden="true" />
                <span className="delete-project-option-copy">
                  <strong>Delete folder from disk</strong>
                  <small>Permanently erases the folder and every file inside it.</small>
                </span>
                {scope === "disk" ? (
                  <Check className="delete-project-check" aria-hidden="true" />
                ) : null}
              </button>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={scope}
                className="delete-project-consequence"
                data-tone={scope === "disk" ? "danger" : "safe"}
                role="status"
                initial={reduceMotion ? false : { opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -2 }}
                transition={{ duration: reduceMotion ? 0 : 0.12, ease: [0.2, 0, 0, 1] }}
              >
                {scope === "history"
                  ? "You can reopen the folder later. Chat transcripts will not return."
                  : "This cannot be undone. Confirm you have a backup."}
              </motion.p>
            </AnimatePresence>

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
                type="button"
                className="delete-project-confirm"
                data-scope={scope}
                disabled={busy}
                onClick={() => onConfirm(scope)}
              >
                {busy ? "Working…" : confirmLabel}
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
