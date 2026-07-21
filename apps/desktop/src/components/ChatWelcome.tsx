import { m as motion, useReducedMotion } from "motion/react";
import { chatWelcomeGreeting } from "../chatWelcomeGreeting";

export function ChatWelcome({ name = "" }: { name?: string }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.section
      className="empty-task-state chat-welcome-state"
      aria-labelledby="chat-welcome-title"
      initial={reduceMotion ? false : { opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.2, 0, 0, 1] }}
    >
      <span className="empty-task-mark" aria-hidden="true">
        <span className="brand-mark-glyph brand-mark-glyph--lg" />
      </span>
      <h2 id="chat-welcome-title">{chatWelcomeGreeting(name)}</h2>
      <p>Ask a question, explore an idea, or bring in a file.</p>
    </motion.section>
  );
}
