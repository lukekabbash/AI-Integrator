import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import { CircleDollarSign, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { IntegratorMcpServer } from "../bridge";
import type { McpActivationWarning } from "../mcpSettings";

export interface McpActivationRequest {
  server: IntegratorMcpServer;
  warning: McpActivationWarning;
}

interface McpActivationDialogProps {
  request: McpActivationRequest | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function McpActivationDialog({ request, onClose, onConfirm }: McpActivationDialogProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const serverName = request?.server.name ?? "";

  useEffect(() => {
    if (!serverName) return;
    cancelRef.current?.focus();
  }, [serverName]);

  const modal = (
    <AnimatePresence>
      {request ? (
        <motion.div
          className="mcp-activation-backdrop"
          role="presentation"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.16 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.section
            className="mcp-activation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            initial={reduceMotion ? false : { opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -7, scale: 0.99 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 460, damping: 38, mass: 0.74 }
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
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
            <header className="mcp-activation-header">
              <span aria-hidden>
                <TriangleAlert />
              </span>
              <div>
                <small>Trading authority</small>
                <h2 id={titleId}>{request.warning.title}</h2>
              </div>
              <button type="button" aria-label="Close" onClick={onClose}>
                <X aria-hidden />
              </button>
            </header>

            <p className="mcp-activation-introduction" id={descriptionId}>
              {request.warning.introduction}
            </p>

            <div className="mcp-activation-disclosures">
              {request.warning.disclosures.map((disclosure, index) => (
                <div key={disclosure.title}>
                  {index === 0 ? <ShieldCheck aria-hidden /> : <CircleDollarSign aria-hidden />}
                  <span>
                    <strong>{disclosure.title}</strong>
                    <small>{disclosure.detail}</small>
                  </span>
                </div>
              ))}
            </div>

            <p className="mcp-activation-note">{request.warning.note}</p>

            <footer className="mcp-activation-footer">
              <button ref={cancelRef} type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" data-action="confirm" onClick={onConfirm}>
                {request.warning.confirmLabel}
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
