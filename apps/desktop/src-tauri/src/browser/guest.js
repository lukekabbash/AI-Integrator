/**
 * Integrator guest runtime.
 *
 * Injected into every browser tab before page scripts run. It gives the app
 * and the agent a small, stable surface over an arbitrary page: an
 * accessibility-shaped snapshot with stable refs, synthesized interaction,
 * an element picker and an annotation overlay. Everything is called through
 * `eval_with_callback`, so each entry point returns a JSON-serialisable value
 * and never throws across the boundary.
 */
(() => {
  if (window.__integrator) return;

  const REFS = new Map(); // ref -> WeakRef<Element>
  const BY_ELEMENT = new WeakMap(); // Element -> ref
  let refSeq = 0;
  let generation = 0;

  const ok = (value) => ({ ok: true, value: value ?? null });
  const err = (code, message) => ({ ok: false, error: { code, message: String(message) } });

  function refFor(element) {
    let ref = BY_ELEMENT.get(element);
    if (ref && REFS.get(ref)?.deref() === element) return ref;
    ref = `e${++refSeq}`;
    BY_ELEMENT.set(element, ref);
    REFS.set(ref, new WeakRef(element));
    return ref;
  }

  function elementForRef(ref) {
    const element = REFS.get(ref)?.deref();
    if (!element || !element.isConnected) return null;
    return element;
  }

  /* ---------------------------------------------------------------- roles */

  const ROLE_BY_TAG = {
    a: "link",
    button: "button",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    img: "image",
    input: "textbox",
    select: "combobox",
    textarea: "textbox",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    form: "form",
    table: "table",
    tr: "row",
    td: "cell",
    th: "columnheader",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    summary: "button",
    label: "label",
    p: "paragraph",
    video: "video",
    audio: "audio",
  };

  const INPUT_ROLE = {
    button: "button",
    submit: "button",
    reset: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    file: "button",
    image: "button",
    search: "searchbox",
  };

  function roleOf(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === "input") return INPUT_ROLE[element.type] ?? "textbox";
    if (tag === "a" && !element.hasAttribute("href")) return "";
    return ROLE_BY_TAG[tag] ?? "";
  }

  function accessibleName(element) {
    const label = element.getAttribute("aria-label");
    if (label?.trim()) return label.trim();
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    if (element.labels?.length) {
      const text = [...element.labels].map((l) => l.textContent ?? "").join(" ").trim();
      if (text) return text;
    }
    const attr =
      element.getAttribute("alt") ??
      element.getAttribute("title") ??
      element.getAttribute("placeholder") ??
      (element.tagName === "INPUT" && element.type === "submit" ? element.value : "");
    if (attr?.trim()) return attr.trim();
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }

  function visible(element) {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function cssPath(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `${element.tagName.toLowerCase()}[data-testid="${CSS.escape(testId)}"]`;
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(part);
        break;
      }
      const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      if (node.id) {
        parts[0] = `#${CSS.escape(node.id)}`;
        break;
      }
      node = parent;
    }
    return parts.join(" > ");
  }

  const INTERACTIVE =
    "a[href],button,input,textarea,select,summary,[role],[tabindex]:not([tabindex='-1']),[contenteditable='true']";

  function describe(element) {
    const rect = element.getBoundingClientRect();
    return {
      ref: refFor(element),
      role: roleOf(element) || element.tagName.toLowerCase(),
      name: accessibleName(element),
      tag: element.tagName.toLowerCase(),
      selector: cssPath(element),
      disabled: Boolean(element.disabled),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  /* ------------------------------------------------------------ targeting */

  function resolve(target) {
    if (!target) return null;
    if (target.ref) return elementForRef(target.ref);
    if (target.selector) {
      try {
        return document.querySelector(target.selector);
      } catch {
        return null;
      }
    }
    if (target.text) {
      const wanted = String(target.text).toLowerCase();
      const role = target.role ? String(target.role).toLowerCase() : null;
      const candidates = [...document.querySelectorAll(INTERACTIVE), ...document.querySelectorAll("*")];
      for (const element of candidates) {
        if (!visible(element)) continue;
        if (role && roleOf(element).toLowerCase() !== role) continue;
        const name = accessibleName(element).toLowerCase();
        if (target.exact ? name === wanted : name.includes(wanted)) return element;
      }
    }
    return null;
  }

  function centreOf(element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function pointerSequence(element, point, options = {}) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      button: options.button ?? 0,
      buttons: 1,
      ctrlKey: Boolean(options.ctrlKey),
      shiftKey: Boolean(options.shiftKey),
      altKey: Boolean(options.altKey),
      metaKey: Boolean(options.metaKey),
    };
    element.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mousedown", base));
    if (typeof element.focus === "function") element.focus({ preventScroll: true });
    element.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 1 }));
  }

  function setValue(element, value) {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  /* ---------------------------------------------------------------- picker */

  const OVERLAY_ID = "__integrator_overlay";
  let overlayHost = null;
  let overlayRoot = null;
  let pickState = null;

  function ensureOverlay() {
    if (overlayHost?.isConnected) return overlayRoot;
    overlayHost = document.createElement("div");
    overlayHost.id = OVERLAY_ID;
    overlayHost.setAttribute("data-integrator-ui", "true");
    overlayHost.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style;";
    overlayRoot = overlayHost.attachShadow({ mode: "closed" });
    overlayRoot.innerHTML = `<style>
      .box{position:fixed;border:2px solid var(--accent,#4c8dff);border-radius:3px;pointer-events:none;
           box-shadow:0 0 0 9999px rgba(0,0,0,.06)}
      .label{position:fixed;padding:2px 6px;border-radius:4px;background:var(--accent,#4c8dff);
             color:#fff;font:11px/1.4 ui-sans-serif,system-ui,sans-serif;pointer-events:none;white-space:nowrap}
      .region{position:fixed;border:2px dashed var(--accent,#4c8dff);border-radius:4px;
              background:rgba(76,141,255,.10);pointer-events:none}
      svg{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none}
      path{fill:none;stroke:var(--accent,#4c8dff);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
      .note{position:fixed;z-index:2;width:296px;padding:12px;pointer-events:auto;
            border-radius:var(--radius,12px);
            background:var(--surface,#16191d);color:var(--ink,#e7ebf0);
            border:1px solid var(--line,rgba(255,255,255,.14));
            box-shadow:0 1px 2px rgba(0,0,0,.10),0 18px 44px rgba(0,0,0,.28);
            font:12px/1.45 var(--font,ui-sans-serif,system-ui,sans-serif)}
      .note b{display:block;margin-bottom:8px;font-size:10px;letter-spacing:.07em;text-transform:uppercase;
              font-weight:650;color:var(--muted,#96a0ab)}
      .note textarea{width:100%;min-height:68px;padding:8px 9px;border-radius:calc(var(--radius,12px) - 4px);
                     resize:vertical;box-sizing:border-box;
                     background:var(--field,rgba(255,255,255,.05));color:inherit;
                     border:1px solid var(--line,rgba(255,255,255,.14));font:inherit}
      .note textarea::placeholder{color:var(--muted,#96a0ab)}
      .note textarea:focus{outline:none;border-color:var(--accent,#4c8dff);
                           box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#4c8dff) 22%,transparent)}
      .note .row{margin-top:10px;display:flex;gap:6px;justify-content:flex-end}
      .note button{padding:6px 12px;border-radius:calc(var(--radius,12px) - 5px);
                   border:1px solid var(--line,rgba(255,255,255,.14));
                   background:transparent;color:inherit;font:inherit;font-size:11px;font-weight:550;
                   cursor:pointer;transition:background-color .14s ease,border-color .14s ease}
      .note button:hover{background:color-mix(in srgb,var(--ink,#e7ebf0) 8%,transparent)}
      .note button.primary{background:var(--accent,#4c8dff);border-color:transparent;
                           color:var(--accent-ink,#fff);font-weight:600}
      .note button.primary:hover{filter:brightness(1.06)}
      .note small{display:block;margin-top:8px;color:var(--muted,#96a0ab);font-size:10px}
      /* The agent's own cursor. A page driven from the outside otherwise moves
         by itself with nothing to watch; this shows where the work is landing,
         the way a person's pointer would. It never takes pointer events and it
         is not part of #marks, so clearing annotations leaves it alone. */
      #agent{position:fixed;left:0;top:0;pointer-events:none;opacity:0;
             transition:opacity .18s ease}
      #agent[data-live="true"]{opacity:1}
      #agent .point{position:absolute;left:0;top:0;width:22px;height:22px;
                    transform:translate(-2px,-2px);
                    transition:translate .26s cubic-bezier(.22,1,.28,1)}
      #agent .point svg{display:block;width:22px;height:22px;
                        filter:drop-shadow(0 2px 5px rgba(0,0,0,.35))}
      #agent .ring{position:absolute;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;
                   border:2px solid var(--accent,#4c8dff);border-radius:99px;opacity:0;
                   animation:integrator-tap .5s cubic-bezier(.22,1,.28,1) forwards}
      #agent .label{position:absolute;left:18px;top:16px;padding:2px 7px;border-radius:99px;
                    background:var(--accent,#4c8dff);color:var(--accent-ink,#fff);
                    font:10px/1.5 var(--font,ui-sans-serif,system-ui,sans-serif);
                    font-weight:650;white-space:nowrap;
                    box-shadow:0 2px 8px rgba(0,0,0,.28)}
      @keyframes integrator-tap{
        0%{opacity:.9;transform:scale(.4)}
        100%{opacity:0;transform:scale(2.6)}
      }
      @media (prefers-reduced-motion: reduce){
        #agent .point{transition:none}
        #agent .ring{animation-duration:.01s}
      }
    </style><svg><g id="strokes"></g></svg><div id="marks"></div><div id="agent"></div>`;
    document.documentElement.appendChild(overlayHost);
    return overlayRoot;
  }

  function clearOverlay() {
    overlayHost?.remove();
    overlayHost = null;
    overlayRoot = null;
  }

  /* ------------------------------------------------------------- cursor */

  const CURSOR_GLYPH =
    '<svg viewBox="0 0 24 24" fill="none"><path d="M5 3l13 8.2-5.7 1.1L9.9 18 5 3z" ' +
    'fill="var(--accent,#4c8dff)" stroke="var(--accent-ink,#fff)" stroke-width="1.4" ' +
    'stroke-linejoin="round"/></svg>';
  let cursorIdle = 0;
  let cursorAt = { x: 0, y: 0 };

  /**
   * Shows the agent's pointer at a point and, for anything that lands, a tap
   * ring. `label` names the action so a person watching can follow along.
   * Sync on purpose: the host's entry points return a value, so the animation
   * plays alongside the real event rather than delaying it.
   */
  function agentCursor(point, label) {
    const root = ensureOverlay();
    const layer = root.getElementById("agent");
    if (!layer) return;
    const x = Math.round(point?.x ?? cursorAt.x);
    const y = Math.round(point?.y ?? cursorAt.y);
    cursorAt = { x, y };
    let pointer = layer.querySelector(".point");
    if (!pointer) {
      pointer = document.createElement("div");
      pointer.className = "point";
      pointer.innerHTML = `${CURSOR_GLYPH}<span class="label"></span>`;
      layer.appendChild(pointer);
    }
    pointer.style.translate = `${x}px ${y}px`;
    const caption = pointer.querySelector(".label");
    if (caption) {
      caption.textContent = label ?? "";
      caption.style.display = label ? "" : "none";
    }
    if (label) {
      const ring = document.createElement("div");
      ring.className = "ring";
      ring.style.translate = `${x}px ${y}px`;
      layer.appendChild(ring);
      ring.addEventListener("animationend", () => ring.remove());
    }
    layer.dataset.live = "true";
    clearTimeout(cursorIdle);
    // Fades on its own so a finished run does not leave a pointer parked on
    // the page for the user to wonder about.
    cursorIdle = setTimeout(() => {
      if (layer.isConnected) layer.dataset.live = "false";
    }, 2600);
  }

  function outline(element, label) {
    const root = ensureOverlay();
    const marks = root.getElementById("marks");
    const rect = element.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = "box";
    box.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    marks.appendChild(box);
    if (label) {
      const tag = document.createElement("div");
      tag.className = "label";
      tag.textContent = label;
      // Above the element, or under it when the element is near the top of the
      // viewport — never across the thing the user is trying to look at.
      const above = rect.top >= 26;
      tag.style.cssText = `left:${Math.max(4, rect.left)}px;top:${
        above ? rect.top - 22 : Math.min(window.innerHeight - 22, rect.bottom + 4)
      }px`;
      marks.appendChild(tag);
    }
  }

  /**
   * The host resolves the app's own tokens and passes them in; the overlay
   * carries them so the picker and its note box match the app rather than a
   * fixed dark palette that reads as someone else's UI on a light theme.
   */
  function applyTheme(theme) {
    if (!overlayHost || !theme) return;
    for (const [key, custom] of [
      ["accent", "--accent"],
      ["accentInk", "--accent-ink"],
      ["surface", "--surface"],
      ["ink", "--ink"],
      ["muted", "--muted"],
      ["line", "--line"],
      ["field", "--field"],
      ["radius", "--radius"],
      ["font", "--font"],
    ]) {
      if (theme[key]) overlayHost.style.setProperty(custom, theme[key]);
    }
  }

  /** Floating note anchored beside the picked element. */
  function showNote(element, theme, done) {
    const root = ensureOverlay();
    const rect = element.getBoundingClientRect();
    const note = document.createElement("div");
    note.className = "note";
    note.innerHTML = `<b>Note for the agent</b>
      <textarea placeholder="What should change here?"></textarea>
      <div class="row"><button data-cancel>Cancel</button><button class="primary" data-attach>Attach</button></div>
      <small>Enter attaches · Shift+Enter for a new line · Esc cancels</small>`;
    // Under the element by preference, above it when the element sits low
    // enough that the box would be cut off, and never off either edge.
    const height = 196;
    const width = 296;
    const below = rect.bottom + 10;
    const top =
      below + height <= window.innerHeight - 8
        ? below
        : Math.max(8, Math.min(rect.top - height - 10, window.innerHeight - height - 8));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    note.style.top = `${top}px`;
    note.style.left = `${left}px`;
    applyTheme(theme);
    root.getElementById("marks").appendChild(note);
    overlayHost.style.pointerEvents = "auto";
    const textarea = note.querySelector("textarea");
    textarea.focus();
    const finish = (submitted) => done(textarea.value.trim(), submitted);
    note.querySelector("[data-attach]").addEventListener("click", () => finish(true));
    note.querySelector("[data-cancel]").addEventListener("click", () => finish(false));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        finish(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
      event.stopPropagation();
    });
  }

  /* ------------------------------------------------------------------ api */

  const api = {
    version: 1,

    /** Hands the overlay the app's own tokens, so the cursor, the picker and
     *  the note box match the theme the user is looking at. */
    setTheme(theme) {
      ensureOverlay();
      applyTheme(theme);
      return ok({ themed: true });
    },

    snapshot(options = {}) {
      const limit = Math.min(options.limit ?? 200, 500);
      const elements = [];
      for (const element of document.querySelectorAll(INTERACTIVE)) {
        if (!visible(element)) continue;
        elements.push(describe(element));
        if (elements.length >= limit) break;
      }
      const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
      return ok({
        url: location.href,
        title: document.title,
        generation,
        loading: document.readyState !== "complete",
        viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY) },
        elements,
        text: text.length > 20000 ? `${text.slice(0, 20000)}…` : text,
      });
    },

    click(target, options = {}) {
      const element = resolve(target);
      if (!element) return err("not-found", "No element matched that target.");
      element.scrollIntoView({ block: "center", inline: "center" });
      const point = target.x != null && target.y != null ? { x: target.x, y: target.y } : centreOf(element);
      agentCursor(point, "click");
      pointerSequence(element, point, options);
      return ok({ clicked: describe(element) });
    },

    type(target, text, options = {}) {
      const element = target ? resolve(target) : document.activeElement;
      if (!element) return err("not-found", "No element matched that target.");
      if (!("value" in element) && element.contentEditable !== "true") {
        return err("not-editable", "That element does not accept text.");
      }
      element.scrollIntoView({ block: "center" });
      agentCursor(centreOf(element), text.length > 12 ? "typing" : `typing “${text}”`);
      element.focus({ preventScroll: true });
      if (element.contentEditable === "true") {
        if (options.clear) element.textContent = "";
        element.textContent += text;
      } else {
        setValue(element, options.clear ? text : `${element.value ?? ""}${text}`);
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return ok({ typed: text.length });
    },

    press(key, modifiers = []) {
      const element = document.activeElement ?? document.body;
      agentCursor(centreOf(element), [...modifiers, key].join("+"));
      const init = {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
        ctrlKey: modifiers.includes("Control"),
        shiftKey: modifiers.includes("Shift"),
        altKey: modifiers.includes("Alt"),
        metaKey: modifiers.includes("Meta"),
      };
      element.dispatchEvent(new KeyboardEvent("keydown", init));
      if (key === "Enter" && element instanceof HTMLFormElement) element.requestSubmit?.();
      element.dispatchEvent(new KeyboardEvent("keyup", init));
      return ok({ key });
    },

    scroll(target, deltaX = 0, deltaY = 0) {
      const element = target ? resolve(target) : null;
      agentCursor(element ? centreOf(element) : { x: innerWidth / 2, y: innerHeight / 2 }, "scroll");
      (element ?? window).scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
      return ok({ scrollY: Math.round(scrollY) });
    },

    waitFor(condition = {}) {
      if (condition.urlIncludes && !location.href.includes(condition.urlIncludes)) {
        return ok({ matched: false });
      }
      if (condition.text) {
        const body = document.body?.innerText ?? "";
        if (!body.includes(condition.text)) return ok({ matched: false });
      }
      if (condition.selector || condition.ref || condition.role) {
        const element = resolve(condition);
        if (!element || !visible(element)) return ok({ matched: false });
      }
      return ok({ matched: true });
    },

    evaluate(expression) {
      try {
        // Deliberate: `browser_evaluate` exists to run caller-supplied page
        // expressions, and the guest is already inside the page's own origin.
        const value = Function(`"use strict";return (${expression})`)();
        const json = JSON.stringify(value ?? null);
        if (json && json.length > 64000) return err("too-large", "Result exceeds 64 KB.");
        return ok(json === undefined ? null : JSON.parse(json));
      } catch (error) {
        return err("evaluate-failed", error?.message ?? error);
      }
    },

    /** Highlights an element without acting on it, for the agent cursor. */
    highlight(target) {
      const element = resolve(target);
      if (!element) return err("not-found", "No element matched that target.");
      ensureOverlay().getElementById("marks").replaceChildren();
      outline(element, accessibleName(element).slice(0, 40) || element.tagName.toLowerCase());
      setTimeout(clearOverlay, 900);
      return ok({ highlighted: describe(element) });
    },

    /** Starts the element picker; the host polls pickResult(). */
    startPick(theme) {
      api.cancelPick();
      const root = ensureOverlay();
      applyTheme(theme);
      overlayHost.style.pointerEvents = "auto";
      overlayHost.style.cursor = "crosshair";
      const marks = root.getElementById("marks");
      const state = { picked: null, cancelled: false, comment: "", done: false };
      const onMove = (event) => {
        overlayHost.style.pointerEvents = "none";
        const element = document.elementFromPoint(event.clientX, event.clientY);
        overlayHost.style.pointerEvents = "auto";
        if (!element || element === overlayHost) return;
        marks.replaceChildren();
        outline(element, accessibleName(element).slice(0, 40) || element.tagName.toLowerCase());
      };
      const onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        overlayHost.style.pointerEvents = "none";
        const element = document.elementFromPoint(event.clientX, event.clientY);
        overlayHost.style.pointerEvents = "auto";
        if (!element) return;
        state.picked = describe(element);
        // Keep the outline and ask for a note, anchored beside the element.
        marks.replaceChildren();
        outline(element, accessibleName(element).slice(0, 40) || element.tagName.toLowerCase());
        overlayHost.style.cursor = "default";
        overlayHost.removeEventListener("pointermove", onMove, true);
        overlayHost.removeEventListener("click", onClick, true);
        showNote(element, theme, (comment, submitted) => {
          if (!submitted) {
            state.cancelled = true;
            state.picked = null;
          } else {
            state.comment = comment;
          }
          state.done = true;
          api.cancelPick();
        });
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          state.cancelled = true;
          api.cancelPick();
        }
      };
      overlayHost.addEventListener("pointermove", onMove, true);
      overlayHost.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKey, true);
      pickState = {
        state,
        teardown: () => {
          overlayHost?.removeEventListener("pointermove", onMove, true);
          overlayHost?.removeEventListener("click", onClick, true);
          window.removeEventListener("keydown", onKey, true);
        },
      };
      return ok({ picking: true });
    },

    pickResult() {
      if (!pickState) return ok({ picking: false, picked: null, cancelled: false });
      const { state } = pickState;
      if (state.done || state.cancelled) {
        const result = {
          picking: false,
          picked: state.picked,
          comment: state.comment ?? "",
          cancelled: state.cancelled,
        };
        pickState = null;
        return ok(result);
      }
      return ok({ picking: true, picked: null, comment: "", cancelled: false });
    },

    cancelPick() {
      pickState?.teardown();
      const carried = pickState?.state;
      if (carried && !carried.picked && !carried.cancelled) carried.cancelled = true;
      clearOverlay();
      return ok({ picking: false });
    },

    /** Draws regions/strokes so a screenshot carries the annotation. */
    annotate(marks = []) {
      const root = ensureOverlay();
      const layer = root.getElementById("marks");
      const strokes = root.getElementById("strokes");
      layer.replaceChildren();
      strokes.replaceChildren();
      for (const mark of marks) {
        if (mark.kind === "region" && mark.rect) {
          const region = document.createElement("div");
          region.className = "region";
          region.style.cssText = `left:${mark.rect.x}px;top:${mark.rect.y}px;width:${mark.rect.width}px;height:${mark.rect.height}px`;
          layer.appendChild(region);
        } else if (mark.kind === "stroke" && mark.points?.length > 1) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          const [first, ...rest] = mark.points;
          path.setAttribute(
            "d",
            `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`,
          );
          strokes.appendChild(path);
        } else if (mark.kind === "element" && mark.ref) {
          const element = elementForRef(mark.ref);
          if (element) outline(element, mark.label);
        }
      }
      return ok({ marks: marks.length });
    },

    clearAnnotations() {
      clearOverlay();
      return ok({ cleared: true });
    },
  };

  addEventListener("pagehide", clearOverlay);
  addEventListener("popstate", () => {
    generation += 1;
    REFS.clear();
  });

  /* ------------------------------------------------------------- pop-ups */

  // A child webview has no window manager of its own: a page that calls
  // window.open would either be silently dropped or escape into a window the
  // app cannot place, watch or close. Turning the request into a navigation in
  // this tab keeps the flow — including OAuth sign-in hops — inside a tab the
  // user and the agent can both see.
  if (window.__integratorBrowser?.keepPopupsInside) {
    window.open = (url) => {
      if (url) location.assign(String(url));
      return null;
    };
    addEventListener(
      "click",
      (event) => {
        const anchor = event.target?.closest?.("a[target]");
        if (!anchor || !anchor.href) return;
        if (anchor.target === "" || anchor.target === "_self") return;
        event.preventDefault();
        location.assign(anchor.href);
      },
      true,
    );
  }

  window.__integrator = api;
})();
