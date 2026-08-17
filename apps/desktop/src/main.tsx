import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const root = document.getElementById("root");

if (!root) throw new Error("AI Integrator root element is missing");

/**
 * The pop-out browser runs the same bundle in its own window. The window label
 * is the only thing that differs, and it is on the URL before any React code
 * runs, so the right surface renders on the first paint instead of flashing
 * the workspace first.
 */
const isBrowserWindow =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("surface") === "browser";

const BrowserWindowShell = lazy(() =>
  import("./components/BrowserWindowShell").then((module) => ({
    default: module.BrowserWindowShell,
  })),
);

createRoot(root).render(
  <StrictMode>
    {isBrowserWindow ? (
      <Suspense fallback={null}>
        <BrowserWindowShell />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
