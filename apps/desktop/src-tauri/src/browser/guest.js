/**
 * Integrator guest runtime.
 *
 * Injected into every browser tab before page scripts run. It gives the app
 * and the agent a small, stable surface over an arbitrary page: an
 * accessibility-shaped snapshot with stable refs, synthesized interaction,
 * an element picker and an annotation overlay. Everything is called through
 * `eval_with_callback`, so each entry point returns a JSON-serialisable value
 * (or a Promise of one) and never throws across the boundary.
 */
(() => {
  // The prelude the host writes just above this script. It is read once and
  // removed before any page script runs, so a page can neither read the
  // host's key nor rewrite the settings the guest was launched with.
  const CONFIG = window.__integratorBrowser ?? {};
  delete window.__integratorBrowser;
  /** Proves a call came from the app rather than from the page or an agent. */
  const HOST_KEY = String(CONFIG.hostKey ?? "");
  // Captured before page scripts can replace it. Context-menu actions use a
  // denied new-window request as a private guest-to-host signal; no page is
  // navigated and no remote IPC capability is exposed.
  const HOST_OPEN = typeof window.open === "function" ? window.open.bind(window) : null;

  const REFS = new Map(); // ref -> WeakRef<Element>
  const BY_ELEMENT = new WeakMap(); // Element -> ref
  let refSeq = 0;
  let generation = 0;

  const ok = (value) => ({ ok: true, value: value ?? null });
  /** Returned by `resolve` for a ref issued by a document that has since gone. */
  const STALE = Symbol("stale-ref");
  const STALE_MESSAGE = "That ref came from a page this tab has since left. Take a fresh snapshot.";
  const err = (code, message) => ({ ok: false, error: { code, message: String(message) } });

  function refFor(element) {
    let ref = BY_ELEMENT.get(element);
    if (ref && REFS.get(ref)?.deref() === element) return ref;
    ref = `e${++refSeq}@${generation}`;
    BY_ELEMENT.set(element, ref);
    REFS.set(ref, new WeakRef(element));
    return ref;
  }

  /** Refs are tagged with the generation that issued them; see `setGeneration`. */
  function generationOf(ref) {
    const at = String(ref).lastIndexOf("@");
    return at === -1 ? null : Number(String(ref).slice(at + 1));
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
      const text = [...element.labels]
        .map((l) => l.textContent ?? "")
        .join(" ")
        .trim();
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
    if (target.ref) {
      const issued = generationOf(target.ref);
      if (issued !== null && issued !== generation) return STALE;
      return elementForRef(target.ref);
    }
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
      const candidates = [
        ...document.querySelectorAll(INTERACTIVE),
        ...document.querySelectorAll("*"),
      ];
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
    // An element inside an iframe measures against that frame's viewport, and
    // the cursor overlay is drawn in this one. Without the frame's own offset
    // the pointer lands somewhere near the top-left of the page instead of on
    // the thing being clicked.
    const offset = frameOffset(element);
    return {
      x: rect.left + rect.width / 2 + offset.x,
      y: rect.top + rect.height / 2 + offset.y,
    };
  }

  /** An element's nearest ancestors, for events that do not bubble. */
  function ancestors(element, depth) {
    const chain = [];
    let node = element.parentElement;
    while (node && chain.length < depth) {
      chain.push(node);
      node = node.parentElement;
    }
    return chain;
  }

  /**
   * Whether a stylesheet on this page reveals something on `:hover` near this
   * element. Read from the rules rather than guessed: a page whose menu is a
   * CSS rule cannot be opened by any event, and the caller deserves to be told
   * that outright instead of watching a hover appear to succeed.
   */
  function cssHoverOnly(element) {
    const scope = [element, ...ancestors(element, 3)];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        // A cross-origin stylesheet cannot be read; it may or may not have one.
        continue;
      }
      for (const rule of rules) {
        const selector = rule.selectorText;
        if (!selector || !selector.includes(":hover")) continue;
        // Only the rules that make something appear count. A colour change on
        // hover is not a menu, and reporting it would cry wolf on every link.
        const text = rule.style?.cssText ?? "";
        if (!/display|visibility|opacity|transform|height/.test(text)) continue;
        const head = selector.split(":hover")[0].split(",").pop()?.trim();
        if (!head) continue;
        try {
          if (scope.some((node) => node.matches(head))) return true;
        } catch {
          // An unparseable selector fragment is not evidence either way.
        }
      }
    }
    return false;
  }

  /** Where an element's document sits inside this one, if it is in a frame. */
  function frameOffset(element) {
    const view = element.ownerDocument?.defaultView;
    if (!view || view === window) return { x: 0, y: 0 };
    let offset = { x: 0, y: 0 };
    let frame = view.frameElement;
    while (frame) {
      const box = frame.getBoundingClientRect();
      offset = { x: offset.x + box.left, y: offset.y + box.top };
      frame = frame.ownerDocument?.defaultView?.frameElement ?? null;
    }
    return offset;
  }

  /* --------------------------------------------------------- the user's turn */

  /**
   * The hold, in the direction the host cannot see.
   *
   * An agent's gestures are synthesized, so they carry `isTrusted: false`; only
   * a real hand moves this. When Settings → Browser “Lock agents out of the
   * tab you are using” is on, writing while the person is mid-keystroke would
   * take the cursor out of their hands — so the guest refuses. Off (the
   * default) both work the same page. Reads are always fine.
   *
   * It has to live here rather than in the host, because a click inside a child
   * webview never reaches the app. The host passes the lock flag live on each
   * call so toggling the setting applies to the open document.
   */
  const USER_HOLD_MS = 45000;
  const AGENT_WRITES = new Set(["click", "type", "press", "scroll", "drag"]);
  let userAt = 0;

  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    addEventListener(
      type,
      (event) => {
        if (event.isTrusted) userAt = Date.now();
      },
      { capture: true, passive: true },
    );
  }

  /** Milliseconds since the person last touched this page, or null if never. */
  function userIdle() {
    return userAt ? Date.now() - userAt : null;
  }

  /* ------------------------------------------------------- a filled secret */

  /**
   * When the app last typed a saved password into this page.
   *
   * From that moment until the page navigates, reading it back is refused:
   * a snapshot could pick up a page that has helpfully switched the field to
   * `type="text"`. The lockout is
   * keyed on "a credential was filled here", never on what the field says it is
   * now, because the page controls that and the page is not trusted.
   *
   * A new document gets a new guest with this unset, which is exactly right:
   * navigating away is the end of the secret being on screen.
   */
  let credentialAt = 0;
  const CREDENTIAL_TTL_MS = 300000;
  const CREDENTIAL_READS = new Set(["snapshot"]);

  function credentialInFlight() {
    return credentialAt > 0 && Date.now() - credentialAt < CREDENTIAL_TTL_MS;
  }

  /**
   * The veto the host consults before every agent action. It evaluates
   * `blocked(method, lockActiveTab) || method(...)`, so an error envelope
   * returned here refuses the action without dispatching it, and `null` lets
   * it through. `lockActiveTab` is the Settings lock, passed live.
   */
  function blocked(method, lockActiveTab) {
    if (credentialInFlight() && CREDENTIAL_READS.has(method)) {
      return err(
        "credential-in-flight",
        "a saved password is filled in on this page, so reading it is refused until " +
          "the form is submitted or the tab navigates. Clicking and typing still work.",
      );
    }
    if (!lockActiveTab || !AGENT_WRITES.has(method)) return null;
    const idle = userIdle();
    if (idle === null || idle >= USER_HOLD_MS) return null;
    return err(
      "user-holding",
      `the person is working in this tab — they touched it ${Math.round(idle / 1000)}s ago. ` +
        "Wait for them to finish, or open your own tab.",
    );
  }

  /**
   * What the page looks like now that the action has landed. Every mutating
   * entry point returns this, so a caller does not have to follow one tool call
   * with a snapshot just to learn whether anything moved.
   */
  function pageState() {
    const focused = document.activeElement;
    return {
      url: location.href,
      title: document.title,
      scrollY: Math.round(scrollY),
      generation,
      viewport: { width: innerWidth, height: innerHeight },
      // A viewport this small means the tab is parked offscreen, not that the
      // page is tiny. Saying so keeps the caller from trusting the geometry.
      offscreen: innerWidth <= 16 || innerHeight <= 16,
      focusedRef: focused && focused !== document.body ? refFor(focused) : null,
      // How long ago a real hand touched this page. When the Settings lock is
      // on, the host turns a fresh number into `heldBy: "you"`.
      userIdleMs: userIdle(),
      // Anything the page tried to ask while that action was landing. Riding
      // along on the reply means a caller learns about a confirm it triggered
      // without having to know to go looking for one.
      dialogs: takeDialogs(),
    };
  }

  /** A field's own value, so `type` can report what actually stuck. */
  function readValue(element) {
    if (!element) return null;
    if (element.contentEditable === "true") return element.textContent ?? "";
    const value = "value" in element ? element.value : null;
    if (typeof value !== "string") return null;
    // Never echo a secret back through a tool reply.
    return element.type === "password" ? null : value;
  }

  /**
   * Submits the form a field belongs to. Synthesized keys do not trigger the
   * browser's own default action, so Enter has to do this itself: ask the form
   * first, then fall back to the control a person pressing Enter would hit.
   */
  function submitFrom(element) {
    const form = element?.form ?? element?.closest?.("form");
    if (!form) return false;
    if (typeof form.requestSubmit === "function") {
      const submitter = form.querySelector(
        "button[type='submit'],input[type='submit'],button:not([type])",
      );
      form.requestSubmit(submitter ?? undefined);
      return true;
    }
    form.submit();
    return true;
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
    element.dispatchEvent(
      new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true }),
    );
    element.dispatchEvent(new MouseEvent("mousedown", base));
    if (typeof element.focus === "function") element.focus({ preventScroll: true });
    element.dispatchEvent(
      new PointerEvent("pointerup", { ...base, buttons: 0, pointerId: 1, isPrimary: true }),
    );
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

  /* ---------------------------------------------------------------- dialogs */

  /**
   * `alert`, `confirm` and `prompt`, made answerable instead of fatal.
   *
   * A child webview has no dialog UI of its own, so the three of them behaved
   * three different ways: alert resolved on its own, confirm always came back
   * cancelled, and prompt blocked the page's main thread — which froze the tab
   * outright, with every subsequent call timing out until the tab was
   * navigated away. A page can call `prompt` for entirely ordinary reasons, so
   * "do not visit such a page" is not an answer.
   *
   * The guest replaces all three with non-blocking stubs, the same way it
   * already replaces `window.open`. Each call is recorded and answered from a
   * policy the caller can set; the page carries on, and the reply to whatever
   * action triggered the dialog says what was asked and what it was told.
   */
  const DIALOG_LIMIT = 8;
  const dialogs = [];
  /** What the next confirm/prompt is answered with. Accepting is the default
   *  for confirm because a page that asks "are you sure" mid-flow is usually
   *  asking about the thing the caller just did on purpose. */
  let dialogPolicy = { confirm: true, prompt: null };

  function recordDialog(kind, message, answer) {
    dialogs.push({
      kind,
      message: String(message ?? "").slice(0, 500),
      answer: typeof answer === "string" ? answer.slice(0, 200) : answer,
    });
    if (dialogs.length > DIALOG_LIMIT) dialogs.shift();
    return answer;
  }

  window.alert = (message) => {
    recordDialog("alert", message, true);
  };
  window.confirm = (message) => recordDialog("confirm", message, dialogPolicy.confirm !== false);
  window.prompt = (message, fallback) => {
    const answer = dialogPolicy.prompt ?? (fallback == null ? null : String(fallback));
    return recordDialog("prompt", message, answer);
  };
  /** Dialogs since the last read, and then forgotten. */
  function takeDialogs() {
    if (!dialogs.length) return undefined;
    return dialogs.splice(0, dialogs.length);
  }

  /* -------------------------------------------------------- consent dialogs */

  /**
   * Marketing-consent dialogs, by vendor rather than by guesswork.
   *
   * A snapshot that lists the page *behind* one of these is a snapshot of a
   * page nobody can click, which is how an agent ends up reporting a button at
   * coordinates it can never reach. So a snapshot taken while one is up returns
   * the dialog and nothing else, and says which vendor it is.
   *
   * The matcher is an allowlist of vendor markup, never words like "accept": a
   * login wall, an age gate and a terms dialog wear the same shape and mean
   * entirely different things, and clicking through those is not ours to do.
   */
  const CONSENT_VENDORS = [
    {
      name: "Cookiebot",
      root: "#CybotCookiebotDialog",
      reject: "#CybotCookiebotDialogBodyButtonDecline",
    },
    {
      name: "OneTrust",
      root: "#onetrust-consent-sdk",
      reject: "#onetrust-reject-all-handler,.ot-pc-refuse-all-handler",
    },
    { name: "Didomi", root: "#didomi-host", reject: "#didomi-notice-disagree-button" },
    {
      name: "Usercentrics",
      root: "#usercentrics-root",
      reject: "[data-testid='uc-deny-all-button']",
    },
    {
      name: "Quantcast",
      root: ".qc-cmp2-container",
      reject: ".qc-cmp2-summary-buttons button[mode='secondary']",
    },
    { name: "consentmanager", root: "#cmpwrapper,#cmpbox", reject: "#cmpbntnotxt,.cmpboxbtnno" },
  ];

  /** The consent dialog on screen right now, if any. */
  function consentDialog() {
    for (const vendor of CONSENT_VENDORS) {
      for (const root of document.querySelectorAll(vendor.root)) {
        if (visible(root)) return { vendor, root };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ login form */

  /** The password field a person would be typing in: visible, and enabled. */
  function passwordField() {
    for (const field of document.querySelectorAll("input[type='password']")) {
      if (!field.disabled && !field.readOnly && visible(field)) return field;
    }
    return null;
  }

  /**
   * The account field belonging to that password field. Sites disagree wildly
   * about markup, so this walks the form the password is in and takes the last
   * text-shaped field before it — which is where the username sits on every
   * sign-in form worth supporting.
   */
  function usernameFieldFor(secretField) {
    if (!secretField) return null;
    const scope = secretField.form ?? secretField.closest("form") ?? document;
    const fields = [...scope.querySelectorAll("input")];
    const at = fields.indexOf(secretField);
    const before = at === -1 ? fields : fields.slice(0, at);
    for (const field of before.reverse()) {
      const type = (field.type || "text").toLowerCase();
      if (!["text", "email", "tel", "username"].includes(type)) continue;
      if (field.disabled || field.readOnly || !visible(field)) continue;
      return field;
    }
    return null;
  }

  /**
   * Walks the page's iframes, appending what is inside a same-origin one to
   * the element list and describing the rest.
   *
   * Refs inside a frame are ordinary refs — they resolve against that frame's
   * document through the same WeakRef map — so a caller clicks them exactly as
   * it clicks anything else. Coordinates are offset by the frame's own
   * position, so a rect means the same thing wherever it came from.
   */
  function describeFrames(elements, limit) {
    const frames = [];
    for (const frame of document.querySelectorAll("iframe,frame")) {
      if (!visible(frame)) continue;
      const box = frame.getBoundingClientRect();
      const entry = {
        ref: refFor(frame),
        src: frame.getAttribute("src") ?? "",
        name: frame.getAttribute("name") ?? frame.getAttribute("title") ?? "",
        rect: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
        readable: false,
      };
      let inner = null;
      try {
        // Cross-origin access throws rather than returning null, and it throws
        // on the property read itself.
        inner = frame.contentDocument;
      } catch {
        inner = null;
      }
      if (inner) {
        entry.readable = true;
        entry.title = inner.title || undefined;
        for (const element of inner.querySelectorAll(INTERACTIVE)) {
          if (elements.length >= limit) break;
          if (!visible(element)) continue;
          const described = describe(element);
          described.rect.x += entry.rect.x;
          described.rect.y += entry.rect.y;
          described.frame = entry.ref;
          elements.push(described);
        }
        const text = (inner.body?.innerText ?? "").trim();
        if (text) entry.text = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
      } else {
        entry.note =
          "another origin owns this frame, so nothing inside it can be read or clicked from here";
      }
      frames.push(entry);
      if (frames.length >= 8) break;
    }
    return frames;
  }

  /** The draggable ancestor of an element, if this is an HTML5 drag source. */
  function draggableFrom(element) {
    const draggable = element.closest?.("[draggable='true'],[draggable]");
    return draggable?.draggable ? draggable : null;
  }

  /**
   * The HTML5 drag-and-drop handshake, with one DataTransfer carried through
   * it the way the browser would.
   *
   * `dragover` must be cancelled for a drop to be allowed — that is the
   * protocol, and a page that forgets it is a page that cannot be dropped on
   * by a real mouse either. Calling `preventDefault` on the page's behalf
   * would make a broken target look like a working one, so the drop is only
   * dispatched when the target actually accepts.
   */
  function dragSequence(source, over, base, start, end) {
    const data = new DataTransfer();
    data.effectAllowed = "all";
    const event = (type, point, cancelable = true) =>
      new DragEvent(type, { ...base(point, 1), cancelable, dataTransfer: data });
    source.dispatchEvent(event("dragstart", start, false));
    const destination = over ?? source;
    destination.dispatchEvent(event("dragenter", end));
    const dragover = event("dragover", end);
    const accepted = !destination.dispatchEvent(dragover);
    if (accepted) destination.dispatchEvent(event("drop", end));
    source.dispatchEvent(event("dragend", end, false));
    return accepted;
  }

  /**
   * Picks an option in a dropdown by its label, its value, or its position.
   *
   * Native select menus are drawn by the operating system, so there is nothing
   * on the page to click open and no list to click inside — the only honest
   * way to work one is to set the selection and fire the events a page listens
   * for.
   */
  function chooseOption(select, wanted) {
    const text = String(wanted ?? "").trim();
    const lower = text.toLowerCase();
    const options = [...select.options];
    const index = Number.parseInt(text, 10);
    const match =
      options.find((option) => option.value === text) ??
      options.find((option) => option.label.trim().toLowerCase() === lower) ??
      options.find((option) => option.text.trim().toLowerCase().includes(lower)) ??
      (/^\d+$/.test(text) ? options[index] : undefined);
    if (!match) {
      return err(
        "not-found",
        `no option matched "${text}". This dropdown offers: ${options
          .map((option) => option.text.trim())
          .filter(Boolean)
          .slice(0, 20)
          .join(", ")}`,
      );
    }
    return schedule(agentCursor(centreOf(select), `choose “${match.text.trim()}”`), () => {
      agentTap();
      select.value = match.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }).then(() =>
      ok({
        chose: match.text.trim(),
        value: match.value,
        selectedIndex: select.selectedIndex,
        ...pageState(),
      }),
    );
  }

  /** The `code` for a key: the physical key, not the character it produces. */
  function keyCode(key) {
    if (key === " " || key === "Space") return "Space";
    if (key.length !== 1) return key;
    if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/[0-9]/.test(key)) return `Digit${key}`;
    return key;
  }

  /** Modifiers that turn a keypress into a shortcut rather than a character. */
  function isChording(modifier) {
    return modifier === "Control" || modifier === "Alt" || modifier === "Meta";
  }

  /**
   * Writes one character into whatever is focused, the way the browser would
   * have if the key had been real. Synthesized keys run no default action, so
   * without this a printable keypress is a sound with no effect.
   */
  function insertText(element, text) {
    if (element.contentEditable === "true") {
      element.textContent = `${element.textContent ?? ""}${text}`;
    } else if ("value" in element && typeof element.value === "string") {
      const at = element.selectionStart;
      const to = element.selectionEnd;
      const current = element.value;
      if (typeof at === "number" && typeof to === "number") {
        setValue(element, current.slice(0, at) + text + current.slice(to));
        const caret = at + text.length;
        try {
          element.setSelectionRange(caret, caret);
        } catch {
          // Number and email inputs refuse a selection range; the value stuck.
        }
      } else {
        setValue(element, current + text);
      }
    } else {
      return false;
    }
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
    );
    return true;
  }

  /** The events a framework-backed field needs to believe a value changed. */
  function fieldChanged(field) {
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ---------------------------------------------------------------- picker */

  const OVERLAY_ID = "__integrator_overlay";
  let overlayHost = null;
  let overlayRoot = null;
  let pickState = null;
  let contextMenu = null;
  let overlayTheme = null;

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
      .context-menu{position:fixed;z-index:4;min-width:224px;max-width:292px;padding:6px;
                    pointer-events:auto;box-sizing:border-box;
                    border:1px solid var(--line,rgba(255,255,255,.14));
                    border-radius:var(--radius,12px);background:var(--surface,#16191d);
                    color:var(--ink,#e7ebf0);
                    box-shadow:0 2px 5px rgba(0,0,0,.16),0 18px 48px rgba(0,0,0,.30);
                    font:12px/1.35 var(--font,ui-sans-serif,system-ui,sans-serif)}
      .context-menu .context-label{padding:5px 9px 7px;overflow:hidden;white-space:nowrap;
                                   text-overflow:ellipsis;color:var(--muted,#96a0ab);
                                   font-size:10px;font-weight:620;letter-spacing:.03em}
      .context-menu button{display:flex;width:100%;align-items:center;justify-content:space-between;
                           gap:14px;padding:7px 9px;border:0;border-radius:calc(var(--radius,12px) - 5px);
                           background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .context-menu button:hover,.context-menu button:focus-visible{
                           outline:none;background:color-mix(in srgb,var(--ink,#e7ebf0) 8%,transparent)}
      .context-menu button:active{background:color-mix(in srgb,var(--ink,#e7ebf0) 13%,transparent)}
      .context-menu button small{flex:none;color:var(--muted,#96a0ab);font-size:10px}
      .context-menu hr{height:1px;margin:5px 6px;border:0;background:var(--line,rgba(255,255,255,.14))}
      .host-tooltip{position:fixed;z-index:5;top:8px;max-width:min(280px,calc(100vw - 16px));
                    padding:5px 8px;box-sizing:border-box;pointer-events:none;
                    border:1px solid var(--line,rgba(255,255,255,.14));
                    border-radius:calc(var(--radius,12px) - 4px);
                    background:var(--surface,#16191d);color:var(--ink,#e7ebf0);
                    box-shadow:0 8px 24px rgba(0,0,0,.24);
                    font:11px/1.35 var(--font,ui-sans-serif,system-ui,sans-serif);
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      /* The agent's own cursor. A page driven from the outside otherwise moves
         by itself with nothing to watch; this shows where the work is landing,
         the way a person's pointer would. It never takes pointer events and it
         is not part of #marks, so clearing annotations leaves it alone. */
      #agent{position:fixed;left:0;top:0;pointer-events:none;opacity:0}
      #agent[data-live="true"]{opacity:1}
      /* Travel uses a long ease-out so the pointer arrives the way a hand does:
         quickly at first, settling at the end. The glow trails a beat behind it,
         which is what reads as weight rather than teleporting. */
      #agent .point{position:absolute;left:0;top:0;width:26px;height:26px;
                    transition:translate .42s cubic-bezier(.16,1,.3,1)}
      #agent .point .glyph{display:block;width:26px;height:26px;transform-origin:4px 3px;
                           transition:transform .16s cubic-bezier(.34,1.56,.64,1);
                           filter:drop-shadow(0 3px 8px rgba(0,0,0,.30))
                                  drop-shadow(0 1px 2px rgba(0,0,0,.22))}
      #agent[data-press="true"] .point .glyph{transform:scale(.82)}
      #agent .halo{position:absolute;left:0;top:0;width:34px;height:34px;margin:-6px 0 0 -6px;
                   border-radius:99px;opacity:.16;
                   background:radial-gradient(circle,var(--accent,#4c8dff) 0%,transparent 68%);
                   transition:translate .52s cubic-bezier(.16,1,.3,1),opacity .3s ease}
      #agent .ring{position:absolute;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;
                   border:2px solid var(--accent,#4c8dff);border-radius:99px;opacity:0;
                   animation:integrator-tap .62s cubic-bezier(.16,1,.3,1) forwards}
      #agent .trail{position:absolute;left:0;top:0;height:2px;border-radius:99px;
                    transform-origin:0 50%;opacity:0;
                    background:linear-gradient(90deg,transparent,var(--accent,#4c8dff));
                    animation:integrator-trail .5s cubic-bezier(.16,1,.3,1) forwards}
      #agent .label{position:absolute;left:20px;top:19px;padding:3px 8px;
                    border-radius:calc(var(--radius,12px) - 5px);
                    background:var(--accent,#4c8dff);color:var(--accent-ink,#fff);
                    font:10px/1.45 var(--font,ui-sans-serif,system-ui,sans-serif);
                    font-weight:640;letter-spacing:.01em;white-space:nowrap;
                    opacity:0;transform:translateY(-2px);
                    transition:opacity .22s ease,transform .22s cubic-bezier(.16,1,.3,1);
                    box-shadow:0 4px 14px rgba(0,0,0,.26)}
      #agent[data-acting="true"] .label{opacity:1;transform:translateY(0)}
      @keyframes integrator-tap{
        0%{opacity:.85;transform:scale(.35)}
        70%{opacity:.35}
        100%{opacity:0;transform:scale(2.4)}
      }
      @keyframes integrator-trail{
        0%{opacity:.5}
        100%{opacity:0}
      }
      @media (prefers-reduced-motion: reduce){
        #agent .point,#agent .halo,#agent .label{transition:none}
        #agent .ring,#agent .trail{animation-duration:.01s}
      }
    </style><svg><g id="strokes"></g></svg><div id="marks"></div><div id="agent"></div>`;
    document.documentElement.appendChild(overlayHost);
    if (overlayTheme) applyTheme(overlayTheme);
    return overlayRoot;
  }

  function clearOverlay() {
    overlayHost?.remove();
    overlayHost = null;
    overlayRoot = null;
    contextMenu = null;
  }

  /* ------------------------------------------------------------- cursor */

  // A pointer with a little weight to it: a filled arrow with a soft rim so it
  // reads on any page, a highlight down one edge, and a shadow that lifts it
  // off the content.
  const CURSOR_GLYPH =
    '<svg class="glyph" viewBox="0 0 26 26" fill="none">' +
    '<path d="M5.2 3.1 19.6 12.2a.7.7 0 0 1-.24 1.28l-5.03.95a.7.7 0 0 0-.47.34l-2.6 4.6a.7.7 0 0 1-1.3-.2L5.2 3.1Z" ' +
    'fill="var(--accent,#4c8dff)" stroke="var(--accent-ink,#fff)" stroke-width="1.5" ' +
    'stroke-linejoin="round"/>' +
    '<path d="M6.9 6.2 9.4 15l1.5-2.7 2.9-.55Z" fill="var(--accent-ink,#fff)" opacity=".22"/>' +
    "</svg>";
  /** How long the pointer travels before an action lands on the page. */
  const CURSOR_TRAVEL_MS = 420;
  /** The pointer stays put this long after the last action, then fades. */
  const CURSOR_IDLE_MS = 120_000;
  let cursorIdle = 0;
  let cursorActing = 0;
  let cursorAt = { x: 0, y: 0 };
  let cursorReady = false;

  const reducedMotion = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /**
   * Moves the agent's pointer to a point and names what it is about to do.
   * Returns how long the caller should wait before the real event lands, so
   * the page reacts as the pointer arrives rather than before it sets off.
   */
  function agentCursor(point, label) {
    const root = ensureOverlay();
    const layer = root.getElementById("agent");
    if (!layer) return 0;
    const x = Math.round(point?.x ?? cursorAt.x);
    const y = Math.round(point?.y ?? cursorAt.y);

    let pointer = layer.querySelector(".point");
    let halo = layer.querySelector(".halo");
    if (!pointer) {
      halo = document.createElement("div");
      halo.className = "halo";
      layer.appendChild(halo);
      pointer = document.createElement("div");
      pointer.className = "point";
      pointer.innerHTML = `${CURSOR_GLYPH}<span class="label"></span>`;
      layer.appendChild(pointer);
    }
    // First appearance on a document starts from the middle of the page so
    // the pointer glides onto the target instead of popping in on top of it
    // after the click has already happened.
    if (!cursorReady) {
      const origin = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
      pointer.style.transition = "none";
      halo.style.transition = "none";
      pointer.style.translate = `${origin.x}px ${origin.y}px`;
      halo.style.translate = `${origin.x}px ${origin.y}px`;
      pointer.getBoundingClientRect();
      pointer.style.transition = "";
      halo.style.transition = "";
      cursorAt = origin;
      cursorReady = true;
    }
    const from = cursorAt;
    const distance = Math.hypot(x - from.x, y - from.y);
    cursorAt = { x, y };
    pointer.style.translate = `${x}px ${y}px`;
    if (halo) halo.style.translate = `${x}px ${y}px`;

    // A faint streak along the path, drawn once and left to fade. Short hops
    // do not get one; they read as jitter rather than movement.
    if (distance > 48 && !reducedMotion()) {
      const trail = document.createElement("div");
      trail.className = "trail";
      trail.style.width = `${Math.round(distance)}px`;
      trail.style.translate = `${from.x}px ${from.y}px`;
      trail.style.rotate = `${Math.atan2(y - from.y, x - from.x)}rad`;
      layer.appendChild(trail);
      trail.addEventListener("animationend", () => trail.remove());
    }

    const caption = pointer.querySelector(".label");
    if (caption && label) caption.textContent = label;
    layer.dataset.live = "true";
    layer.dataset.acting = label ? "true" : "false";
    clearTimeout(cursorActing);
    cursorActing = setTimeout(() => {
      if (layer.isConnected) layer.dataset.acting = "false";
    }, 1400);

    clearTimeout(cursorIdle);
    // It stays where it finished for a good while: a pointer that vanishes the
    // moment a run pauses makes the next action look like it came from nowhere.
    cursorIdle = setTimeout(() => {
      if (layer.isConnected) layer.dataset.live = "false";
    }, CURSOR_IDLE_MS);

    if (reducedMotion()) return 0;
    // Nearby targets do not need the full travel time.
    return distance < 8 ? 60 : Math.min(CURSOR_TRAVEL_MS, 140 + distance * 0.5);
  }

  /** The press itself: the arrow dips, a ring spreads from the point. */
  function agentTap() {
    const root = ensureOverlay();
    const layer = root.getElementById("agent");
    if (!layer) return;
    layer.dataset.press = "true";
    setTimeout(() => {
      if (layer.isConnected) layer.dataset.press = "false";
    }, 150);
    const ring = document.createElement("div");
    ring.className = "ring";
    ring.style.translate = `${cursorAt.x}px ${cursorAt.y}px`;
    layer.appendChild(ring);
    ring.addEventListener("animationend", () => ring.remove());
  }

  /**
   * Glides the pointer, then runs the gesture once it arrives.
   *
   * The caller awaits this so the reply describes the page after the action,
   * not before. Snapshot and wait still flush a leftover hop so they never
   * read a half-finished drag. A navigation flushes too, so a click that
   * leaves the page still lands and the host is not left waiting.
   */
  let pending = null;

  function schedule(delay, run) {
    flushPending();
    const start = () => Promise.resolve().then(run);
    if (reducedMotion() || !(delay > 0)) return start();
    return new Promise((resolve, reject) => {
      const finish = () => {
        pending = null;
        start().then(resolve, reject);
      };
      pending = { timer: setTimeout(finish, delay), run: finish };
    });
  }

  function flushPending() {
    if (!pending) return;
    const job = pending;
    pending = null;
    clearTimeout(job.timer);
    job.run();
  }

  addEventListener("pagehide", flushPending, { capture: true });

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
    overlayTheme = theme ?? overlayTheme;
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
    applyPageChrome(theme);
  }

  const PAGE_CHROME_ID = "__integrator_page_chrome";

  /**
   * Dresses only the page chrome Integrator owns: a thin scrollbar in the
   * user's palette. Never force the document's `color-scheme`. Sites commonly
   * combine a fixed light background with the browser's default CanvasText;
   * forcing dark controls makes that text white on white. Page appearance is
   * the site's decision; Integrator's overlays still use the supplied theme.
   */
  function applyPageChrome(theme) {
    document.documentElement.style.removeProperty("color-scheme");
    const thumb = theme?.scrollThumb || theme?.muted;
    if (!thumb) return;
    let style = document.getElementById(PAGE_CHROME_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = PAGE_CHROME_ID;
      (document.head ?? document.documentElement).appendChild(style);
    }
    style.textContent = `
      *{scrollbar-width:thin;scrollbar-color:${thumb} transparent}
      ::-webkit-scrollbar{width:10px;height:10px}
      ::-webkit-scrollbar-track{background:transparent}
      ::-webkit-scrollbar-thumb{background:${thumb};border:3px solid transparent;
        background-clip:content-box;border-radius:99px;min-height:32px}
      ::-webkit-scrollbar-thumb:hover{background:${theme?.scrollThumbHover || thumb};
        border:2px solid transparent;background-clip:content-box}
      ::-webkit-scrollbar-corner{background:transparent}`;
  }

  /** A toolbar tooltip must share the native page's layer. Moving the webview
   *  to reveal an HTML bubble made every hover look like a miniature resize. */
  function hostTooltip(value) {
    const root = ensureOverlay();
    let bubble = root.getElementById("host-tooltip");
    if (!value || typeof value.label !== "string") {
      bubble?.remove();
      return ok({ visible: false });
    }
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.id = "host-tooltip";
      bubble.className = "host-tooltip";
      bubble.setAttribute("role", "tooltip");
      root.appendChild(bubble);
    }
    bubble.textContent = value.label.slice(0, 120);
    bubble.style.left = "8px";
    const width = bubble.getBoundingClientRect().width;
    const wanted = Number.isFinite(Number(value.x)) ? Number(value.x) - width / 2 : 8;
    bubble.style.left = `${Math.max(8, Math.min(wanted, window.innerWidth - width - 8))}px`;
    return ok({ visible: true });
  }

  /* --------------------------------------------------------- context menu */

  function contextLink(event) {
    for (const node of event.composedPath()) {
      if (!(node instanceof Element) || node === overlayHost) continue;
      const anchor = node.closest?.("a[href]");
      if (!anchor) continue;
      try {
        const url = new URL(anchor.href, location.href);
        if (url.protocol === "http:" || url.protocol === "https:") return url.href;
      } catch {
        // A malformed or non-web link is not offered to the host.
      }
    }
    return null;
  }

  function contextSelection(target) {
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      target.type !== "password" &&
      typeof target.selectionStart === "number" &&
      typeof target.selectionEnd === "number"
    ) {
      return target.value.slice(target.selectionStart, target.selectionEnd).trim().slice(0, 1600);
    }
    return String(getSelection()?.toString() ?? "")
      .trim()
      .slice(0, 1600);
  }

  function dismissContextMenu() {
    contextMenu?.remove();
    contextMenu = null;
  }

  function signalContextAction(action, url, text) {
    if (!HOST_OPEN || !HOST_KEY) return;
    const query = new URLSearchParams({ key: HOST_KEY, action });
    if (url) query.set("url", url);
    if (text) query.set("text", text);
    // `on_new_window` consumes and denies this request. Capturing the native
    // function before the page loaded keeps the key out of page-owned hooks.
    HOST_OPEN(`integrator-browser-context://action?${query}`, "_blank", "noopener");
  }

  async function copyContextValue(value, button) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.cssText = "position:fixed;left:-9999px;top:0";
      document.documentElement.appendChild(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    const label = button.querySelector("span");
    if (label) label.textContent = "Copied";
    setTimeout(dismissContextMenu, 480);
  }

  function contextMenuButton(menu, label, hint, run) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    const name = document.createElement("span");
    name.textContent = label;
    button.appendChild(name);
    if (hint) {
      const detail = document.createElement("small");
      detail.textContent = hint;
      button.appendChild(detail);
    }
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      run(button);
    });
    menu.appendChild(button);
  }

  function showContextMenu(event) {
    const link = contextLink(event);
    const selection = contextSelection(event.target);
    const pageUrl = location.href;
    const root = ensureOverlay();
    dismissContextMenu();

    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Browser page actions");
    const caption = document.createElement("div");
    caption.className = "context-label";
    try {
      caption.textContent = link ? new URL(link).hostname : document.title || location.hostname;
    } catch {
      caption.textContent = "Browser page";
    }
    menu.appendChild(caption);

    if (link) {
      contextMenuButton(menu, "Open link in new tab", "New tab", () => {
        signalContextAction("open-tab", link, "");
        dismissContextMenu();
      });
    }
    contextMenuButton(menu, link ? "Copy link address" : "Copy page address", "Copy", (button) => {
      void copyContextValue(link ?? pageUrl, button);
    });
    if (selection) {
      contextMenuButton(menu, "Copy selected text", "Copy", (button) => {
        void copyContextValue(selection, button);
      });
    }
    contextMenuButton(menu, "Add to chat", "Agent context", () => {
      signalContextAction("send-chat", link ?? "", selection);
      dismissContextMenu();
    });
    const divider = document.createElement("hr");
    menu.appendChild(divider);
    contextMenuButton(menu, "Refresh page", "Reload", () => {
      dismissContextMenu();
      location.reload();
    });

    menu.style.visibility = "hidden";
    root.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(event.clientX, innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(event.clientY, innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
    contextMenu = menu;
    menu.querySelector("button")?.focus({ preventScroll: true });
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

    /** Whether an agent action should be refused before it is dispatched.
     *  Returns an error envelope, or null when the way is clear. */
    blocked,

    /**
     * Types a saved login into this page's own form.
     *
     * Host-only: the key is written into the prelude and removed before any
     * page script runs, so neither the page nor an agent's `evaluate` can call
     * this — an agent asks the app to fill, and the app decides. The value
     * arrives, goes into the field, and is never returned.
     */
    fillLogin(key, expectedOrigin, username, password, submit) {
      if (!HOST_KEY || key !== HOST_KEY) {
        return err("unauthorized", "only the app can fill a saved login");
      }
      if (location.origin !== expectedOrigin) {
        return err("origin-changed", "the page navigated before the saved login could be filled");
      }
      const secretField = passwordField();
      if (!secretField) return err("not-found", "this page has no password field");
      const nameField = usernameFieldFor(secretField);
      if (nameField && username) {
        nameField.focus({ preventScroll: true });
        setValue(nameField, username);
        fieldChanged(nameField);
      }
      secretField.focus({ preventScroll: true });
      setValue(secretField, password);
      fieldChanged(secretField);
      credentialAt = Date.now();
      const submitted = submit === false ? false : submitFrom(secretField);
      return ok({ filled: true, submitted, username: username ?? null });
    },

    /**
     * Reads back what the person typed into this page's login form, so the app
     * can offer to remember it. Host-only for the same reason as `fillLogin`,
     * and never called for a form the app itself just filled — there is nothing
     * to learn from handing back what we already know.
     */
    captureLogin(key) {
      if (!HOST_KEY || key !== HOST_KEY) {
        return err("unauthorized", "only the app can read a login form");
      }
      const secretField = passwordField();
      const password = secretField?.value ?? "";
      if (!password) return err("not-found", "there is no filled-in password on this page");
      const nameField = usernameFieldFor(secretField);
      return ok({
        origin: location.origin,
        username: nameField?.value?.trim() ?? "",
        password,
      });
    },

    /** Hands the overlay the app's own tokens, so the cursor, the picker and
     *  the note box match the theme the user is looking at. */
    setTheme(theme) {
      ensureOverlay();
      applyTheme(theme);
      return ok({ themed: true });
    },

    hostTooltip,

    /**
     * The host's document counter for this tab. A fresh document gets a fresh
     * guest, so the guest cannot know how many pages came before it — only the
     * host can, and it pushes the number in on every load. Refs are tagged with
     * it, which is what lets a ref from an earlier page report itself as stale
     * instead of merely missing.
     */
    setGeneration(value) {
      const next = Number(value);
      if (!Number.isFinite(next)) return err("invalid-input", "generation must be a number");
      generation = next;
      return ok({ generation });
    },

    /**
     * Moves the pointer over an element without pressing.
     *
     * This reaches a menu that listens for `mouseenter` and cannot reach one
     * that is drawn by a CSS `:hover` rule — that state belongs to the real
     * pointer, and no event a page can be sent will turn it on. The two look
     * identical from outside, so the reply says which kind this element is
     * rather than reporting success over a menu that never opened.
     */
    hover(target) {
      const element = resolve(target);
      if (element === STALE) return err("stale-ref", STALE_MESSAGE);
      if (!element) return err("not-found", "No element matched that target.");
      element.scrollIntoView({ block: "center", inline: "center" });
      const point = centreOf(element);
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
      };
      const chain = [element, ...ancestors(element, 4)];
      return schedule(agentCursor(point, "hover"), () => {
        // Menus usually open from a listener on the wrapper rather than on the
        // link itself, and mouseenter does not bubble, so each is told directly.
        for (const node of chain) {
          node.dispatchEvent(
            new PointerEvent("pointerover", { ...base, pointerId: 1, isPrimary: true }),
          );
          node.dispatchEvent(new MouseEvent("mouseover", base));
          node.dispatchEvent(new MouseEvent("mouseenter", { ...base, bubbles: false }));
          node.dispatchEvent(
            new PointerEvent("pointermove", { ...base, pointerId: 1, isPrimary: true }),
          );
          node.dispatchEvent(new MouseEvent("mousemove", base));
        }
      }).then(() =>
        ok({
          hovered: describe(element),
          ...(cssHoverOnly(element)
            ? {
                cssHoverOnly: true,
                note:
                  "this element's menu opens from a CSS :hover rule, which only a real pointer can set. " +
                  "Nothing here can open it — inspect a snapshot, or click the trigger " +
                  "if it has one.",
              }
            : {}),
          ...pageState(),
        }),
      );
    },

    snapshot(options = {}) {
      // Anything the host asks for settles the action still in flight, so a
      // caller never reads the page mid-gesture.
      flushPending();
      const limit = Math.min(options.limit ?? 200, 500);
      // A consent dialog owns the page while it is up, so it is what a snapshot
      // describes. Reporting the page behind it hands back geometry for
      // controls nothing can reach.
      const consent = consentDialog();
      const scope = consent?.root ?? document;
      const elements = [];
      for (const element of scope.querySelectorAll(INTERACTIVE)) {
        if (!visible(element)) continue;
        elements.push(describe(element));
        if (elements.length >= limit) break;
      }
      // Editors, payment fields and half the widgets on the web live in an
      // iframe, and a snapshot that stops at its border reports an empty page
      // with a rectangle in it. Same-origin frames are walked; cross-origin
      // ones are named and marked, because nothing can read into them and
      // saying so beats leaving a hole.
      const frames = consent ? [] : describeFrames(elements, limit);
      const source = consent ? consent.root : document.body;
      const text = (source?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
      return ok({
        url: location.href,
        title: document.title,
        generation,
        loading: document.readyState !== "complete",
        viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY) },
        ...(consent
          ? {
              kind: "consent-dialog",
              vendor: consent.vendor.name,
              note:
                "a cookie-consent dialog is covering the page — these are its controls. " +
                "Deal with it first; the page behind it cannot be clicked.",
            }
          : {}),
        elements,
        ...(frames.length ? { frames } : {}),
        text: text.length > 20000 ? `${text.slice(0, 20000)}…` : text,
      });
    },

    /**
     * Declines the consent dialog on screen, if it is one we recognise and the
     * user has asked for this. Reject only: accepting on someone's behalf is
     * not a thing an agent gets to do.
     */
    dismissConsent() {
      const consent = consentDialog();
      if (!consent) return ok({ dismissed: false, reason: "no consent dialog is on screen" });
      const button = consent.root.querySelector(consent.vendor.reject);
      if (!button || !visible(button)) {
        return ok({
          dismissed: false,
          vendor: consent.vendor.name,
          reason: "that dialog has no reject control to click",
        });
      }
      return schedule(agentCursor(centreOf(button), "reject"), () => {
        button.click();
      }).then(() => ok({ dismissed: true, vendor: consent.vendor.name }));
    },

    click(target, options = {}) {
      const element = resolve(target);
      if (element === STALE) return err("stale-ref", STALE_MESSAGE);
      if (!element) return err("not-found", "No element matched that target.");
      element.scrollIntoView({ block: "center", inline: "center" });
      const point =
        target.x != null && target.y != null ? { x: target.x, y: target.y } : centreOf(element);
      // The press lands as the pointer arrives, not before it sets off.
      return schedule(agentCursor(point, "click"), () => {
        agentTap();
        pointerSequence(element, point, options);
      }).then(() => ok({ clicked: describe(element), ...pageState() }));
    },

    type(target, text, options = {}) {
      const element = target ? resolve(target) : document.activeElement;
      if (element === STALE) return err("stale-ref", STALE_MESSAGE);
      if (!element) return err("not-found", "No element matched that target.");
      // A <select> has a value but no text to type into it, and setting that
      // value through the input setter threw "Illegal invocation". Typing at a
      // dropdown means choosing the option that reads like what was typed,
      // which is what a person does with a dropdown anyway.
      if (element instanceof HTMLSelectElement) return chooseOption(element, text);
      if (!("value" in element) && element.contentEditable !== "true") {
        return err("not-editable", "That element does not accept text.");
      }
      element.scrollIntoView({ block: "center" });
      const label = text.length > 12 ? "typing" : `typing “${text}”`;
      return schedule(agentCursor(centreOf(element), label), () => {
        agentTap();
        element.focus({ preventScroll: true });
        if (element.contentEditable === "true") {
          if (options.clear) element.textContent = "";
          element.textContent += text;
        } else {
          setValue(element, options.clear ? text : `${element.value ?? ""}${text}`);
        }
        element.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }).then(() => ok({ typed: text.length, value: readValue(element), ...pageState() }));
    },

    press(key, modifiers = []) {
      const element = document.activeElement ?? document.body;
      const delay = agentCursor(centreOf(element), [...modifiers, key].join("+"));
      // "Space" is what a caller naturally writes and what `code` calls the
      // key; `key` itself is a single space, and getting that wrong meant
      // pressing Space typed nothing at all.
      const typed = key === "Space" ? " " : key;
      const init = {
        key: typed,
        code: keyCode(key),
        bubbles: true,
        cancelable: true,
        ctrlKey: modifiers.includes("Control"),
        shiftKey: modifiers.includes("Shift"),
        altKey: modifiers.includes("Alt"),
        metaKey: modifiers.includes("Meta"),
      };
      return schedule(delay, () => {
        agentTap();
        const keydown = new KeyboardEvent("keydown", init);
        const delivered = element.dispatchEvent(keydown);
        // Synthesized keys do not run default actions, so Enter in a field has
        // to submit for itself. The form is the element's owner, never the
        // element — checking `instanceof HTMLFormElement` meant this never
        // fired for the input a person would actually be typing in.
        if (key === "Enter" && delivered && !modifiers.length) submitFrom(element);
        // Nor does a synthesized key insert its own character. A printable one
        // pressed into a field has to be written in, or `press("Space")`
        // reports success over a field that never changed.
        else if (delivered && typed.length === 1 && !modifiers.some(isChording)) {
          insertText(element, typed);
        }
        element.dispatchEvent(new KeyboardEvent("keyup", init));
      }).then(() => ok({ key, value: readValue(element), ...pageState() }));
    },

    /**
     * Press at one point, travel, release at another — a sort, a slider, a
     * canvas stroke. The pointer is moved in steps because most drag
     * implementations listen for movement rather than a single jump, and the
     * agent's cursor follows the same path so the gesture is watchable.
     */
    drag(from, to, options = {}) {
      const source = resolve(from);
      if (source === STALE) return err("stale-ref", STALE_MESSAGE);
      if (!source) return err("not-found", "No element matched the start of the drag.");
      source.scrollIntoView({ block: "center", inline: "center" });
      const start =
        from?.x != null && from?.y != null ? { x: from.x, y: from.y } : centreOf(source);
      const target = to && (to.ref || to.selector || to.text) ? resolve(to) : null;
      const end =
        to?.x != null && to?.y != null ? { x: to.x, y: to.y } : target ? centreOf(target) : null;
      if (!end) return err("not-found", "No element or point matched the end of the drag.");

      const steps = Math.max(
        6,
        Math.min(24, Math.round(Math.hypot(end.x - start.x, end.y - start.y) / 24)),
      );
      const base = (point, buttons) => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: Math.round(point.x),
        clientY: Math.round(point.y),
        button: 0,
        buttons,
        pointerId: 1,
        isPrimary: true,
      });

      // Two entirely separate mechanisms wear the word "drag". A slider or a
      // canvas listens for pointer movement; a list built on the HTML5
      // drag-and-drop API listens for dragstart/dragover/drop and never sees a
      // pointer at all — which is why reordering columns reported success and
      // left them exactly as they were. A page cannot be asked which it uses,
      // so both are performed: the pointer path for one, the drag events for
      // the other, and each ignores the events meant for the other.
      const html5 = draggableFrom(source);

      return schedule(agentCursor(start, "drag"), () => {
        agentTap();
        source.dispatchEvent(new PointerEvent("pointerdown", base(start, 1)));
        source.dispatchEvent(new MouseEvent("mousedown", base(start, 1)));
        if (html5)
          dragSequence(html5, target ?? document.elementFromPoint(end.x, end.y), base, start, end);
        return new Promise((resolve) => {
          const hop = (index) => {
            const ratio = index / steps;
            const at = {
              x: start.x + (end.x - start.x) * ratio,
              y: start.y + (end.y - start.y) * ratio,
            };
            const over = document.elementFromPoint(at.x, at.y) ?? source;
            over.dispatchEvent(new PointerEvent("pointermove", base(at, 1)));
            over.dispatchEvent(new MouseEvent("mousemove", base(at, 1)));
            if (index === steps) {
              agentCursor(end, "drop");
              const dropped = document.elementFromPoint(end.x, end.y) ?? target ?? source;
              dropped.dispatchEvent(new PointerEvent("pointerup", base(end, 0)));
              dropped.dispatchEvent(new MouseEvent("mouseup", base(end, 0)));
              agentTap();
              resolve();
              return;
            }
            // Moving over several frames rather than in one jump: a slider that
            // reads only the final position still works, and one that tracks
            // movement gets something to track.
            setTimeout(() => hop(index + 1), reducedMotion() ? 0 : 16);
          };
          hop(1);
        });
      }).then(() =>
        ok({
          from: describe(source),
          to: target ? describe(target) : end,
          // Which mechanism was used, so a caller reading "moved nothing" knows
          // whether to look at the page or at the gesture.
          kind: html5 ? "html5-drag" : "pointer-drag",
        }),
      );
    },

    scroll(target, deltaX = 0, deltaY = 0) {
      const target_ = target ? resolve(target) : null;
      const element = target_ === STALE ? null : target_;
      const at = element ? centreOf(element) : { x: innerWidth / 2, y: innerHeight / 2 };
      return schedule(agentCursor(at, "scroll"), () => {
        (element ?? window).scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
      }).then(() => ok({ ...pageState() }));
    },

    waitFor(condition = {}) {
      flushPending();
      if (condition.urlIncludes && !location.href.includes(condition.urlIncludes)) {
        return ok({ matched: false });
      }
      if (condition.text) {
        const body = document.body?.innerText ?? "";
        if (!body.includes(condition.text)) return ok({ matched: false });
      }
      if (condition.selector || condition.ref || condition.role) {
        const resolved = resolve(condition);
        const element = resolved === STALE ? null : resolved;
        if (!element || !visible(element)) return ok({ matched: false });
      }
      return ok({ matched: true });
    },

    /** Highlights an element without acting on it, for the agent cursor. */
    highlight(target) {
      const element = resolve(target);
      if (element === STALE) return err("stale-ref", STALE_MESSAGE);
      if (!element) return err("not-found", "No element matched that target.");
      ensureOverlay().getElementById("marks").replaceChildren();
      outline(element, accessibleName(element).slice(0, 40) || element.tagName.toLowerCase());
      // Only the highlight boxes go away. Clearing the whole overlay used to
      // take the agent cursor with it.
      setTimeout(() => {
        overlayRoot?.getElementById("marks")?.replaceChildren();
      }, 900);
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

  addEventListener(
    "contextmenu",
    (event) => {
      if (event.composedPath().includes(overlayHost)) {
        event.preventDefault();
        return;
      }
      if (!event.isTrusted || pickState) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showContextMenu(event);
    },
    true,
  );
  addEventListener(
    "pointerdown",
    (event) => {
      if (contextMenu && !event.composedPath().includes(overlayHost)) dismissContextMenu();
    },
    true,
  );
  addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") dismissContextMenu();
    },
    true,
  );
  addEventListener("scroll", dismissContextMenu, true);
  addEventListener("resize", dismissContextMenu);

  // Only when the user has asked for it, and only ever the reject control.
  if (CONFIG.dismissConsent) {
    const decline = () => {
      if (consentDialog()) api.dismissConsent();
    };
    if (document.readyState === "loading") {
      addEventListener("DOMContentLoaded", () => setTimeout(decline, 400), { once: true });
    } else {
      setTimeout(decline, 400);
    }
  }

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
  if (CONFIG.keepPopupsInside) {
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

  // Page code is untrusted. Keep it from replacing `blocked`, the host-only
  // login methods, or any action before the native side invokes it.
  Object.freeze(api);
  Object.defineProperty(window, "__integrator", {
    value: api,
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
