(() => {
  const HOST_ID = "codex-gemini-reading-marker";
  const MIN_SCROLL_DELTA = 80;
  const SHOW_TOP_AFTER = 280;
  const STORAGE_PREFIX = "gemini-reading-marker:";
  const DEEP_TOP_TIMEOUT_MS = 300000;
  const MARKER_SCROLL_TIMEOUT_MS = 300000;
  const GEMSYNC_SERVER = "http://127.0.0.1:5177";
  const GEMSYNC_PANEL_PATH = "pdf-panel/index.html";
  const OLDER_LOAD_NUDGE_PX = 180;
  const SYNC_TOP_MARGIN_PX = 18;
  const GEMSYNC_PENDING_DOCK_KEY = "gemsync:pending-pdf-dock";

  if (document.getElementById(HOST_ID)) return;

  let chromeContextInvalidated = false;

  const isContextInvalidatedError = (error) => {
    return /Extension context invalidated|context invalidated/i.test(String(error?.message || error || ""));
  };

  const getChromeRuntime = () => {
    if (chromeContextInvalidated) return null;
    try {
      const runtime = globalThis.chrome && globalThis.chrome.runtime;
      return runtime?.id ? runtime : null;
    } catch (error) {
      if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
      return null;
    }
  };

  const getExtensionUrl = (path) => {
    const runtime = getChromeRuntime();
    try {
      return runtime?.getURL ? runtime.getURL(path) : "";
    } catch (error) {
      if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
      return "";
    }
  };

  const getExtensionOrigin = () => {
    const url = getExtensionUrl(GEMSYNC_PANEL_PATH);
    try {
      return url ? new URL(url).origin : "";
    } catch {
      return "";
    }
  };

  const isGemSyncFrameOrigin = (origin) => {
    return String(origin || "").startsWith(GEMSYNC_SERVER)
      || (!!getExtensionOrigin() && origin === getExtensionOrigin());
  };

  const getGemSyncPanelUrl = ({ subjectId = "", deckId = "deck01", page = 1 } = {}) => {
    const extensionUrl = getExtensionUrl(GEMSYNC_PANEL_PATH);
    const safeSubject = encodeURIComponent(subjectId || "");
    const safeDeck = encodeURIComponent(deckId || "deck01");
    const safePage = Math.max(1, Number(page) || 1);
    if (extensionUrl) {
      return `${extensionUrl}#subject=${safeSubject}&deck=${safeDeck}&page=${safePage}&embed=1`;
    }
    return `${GEMSYNC_SERVER}/#deck=${safeDeck}&page=${safePage}&embed=1`;
  };

  const getGemSyncConfigs = async () => {
    const extensionSubjects = getExtensionUrl("pdf-panel/subjects.json");
    if (extensionSubjects) {
      const subjectsResponse = await fetch(extensionSubjects, { cache: "no-store" });
      if (!subjectsResponse.ok) throw new Error(`HTTP ${subjectsResponse.status}`);
      const subjectsConfig = await subjectsResponse.json();
      const subjects = subjectsConfig.subjects || [];
      const configs = [];
      for (const subject of subjects) {
        const configUrl = new URL(subject.configUrl, extensionSubjects).toString();
        const response = await fetch(configUrl, { cache: "no-store" });
        if (!response.ok) continue;
        const config = await response.json();
        configs.push({
          subject,
          config: {
            ...config,
            decks: (config.decks || []).map((deck) => ({ ...deck, subjectId: subject.id })),
          },
        });
      }
      return configs;
    }

    const response = await fetch(`${GEMSYNC_SERVER}/api/config`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return [{ subject: { id: "", title: "" }, config: await response.json() }];
  };

  const readLocalJson = (key) => {
    try {
      const text = localStorage.getItem(key);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  const storage = {
    async get(key) {
      return readLocalJson(key);
    },
    async set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    async remove(key) {
      localStorage.removeItem(key);
    },
  };

  const getConversationKey = () => {
    const match = /^\/app\/([^/?#]+)/.exec(location.pathname);
    return match ? `${STORAGE_PREFIX}${match[1]}` : null;
  };

  const getConversationId = () => {
    return /^\/app\/([^/?#]+)/.exec(location.pathname)?.[1] || "";
  };

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      position: fixed;
      right: 22px;
      bottom: 132px;
      z-index: 2147483647;
      font-family: Google Sans, Roboto, Arial, sans-serif;
    }

    .stack {
      display: grid;
      gap: 14px;
      justify-items: end;
      isolation: isolate;
    }

    button {
      --hot-rgb: 34, 211, 238;
      --warm-rgb: 191, 246, 255;
      --rim-rgb: 103, 232, 249;
      --glass-dark: rgba(4, 10, 38, 0.12);
      --ink: #ffffff;
      position: relative;
      box-sizing: border-box;
      width: 144px;
      height: 48px;
      border: 1px solid rgba(var(--warm-rgb), 0.72);
      border-radius: 999px;
      background:
        radial-gradient(ellipse 82% 98% at 28% 50%, rgba(var(--hot-rgb), 0.86), rgba(var(--rim-rgb), 0.62) 40%, rgba(var(--warm-rgb), 0.34) 61%, rgba(255, 255, 255, 0.12) 100%),
        linear-gradient(90deg, rgba(var(--hot-rgb), 0.5), rgba(var(--warm-rgb), 0.4) 55%, rgba(255, 255, 255, 0.22)),
        rgba(255, 255, 255, 0.16);
      color: var(--ink);
      box-shadow:
        0 14px 30px rgba(2, 6, 23, 0.26),
        0 0 30px rgba(var(--hot-rgb), 0.32),
        0 0 0 1px rgba(var(--warm-rgb), 0.22),
        inset 0 0 22px rgba(var(--warm-rgb), 0.2),
        inset 13px 12px 24px rgba(var(--rim-rgb), 0.24),
        inset -14px -12px 26px var(--glass-dark),
        inset 0 1px 0 rgba(255, 255, 255, 0.82),
        inset 0 -1px 0 rgba(var(--warm-rgb), 0.28);
      cursor: pointer;
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr);
      align-items: center;
      justify-items: center;
      column-gap: 6px;
      padding: 0 14px 0 0;
      font-size: 16px;
      font-weight: 760;
      line-height: 1;
      letter-spacing: 0;
      opacity: 0.96;
      overflow: visible;
      transform: translateZ(0);
      text-shadow:
        0 1px 8px rgba(2, 6, 23, 0.32),
        0 0 12px rgba(255, 255, 255, 0.28);
      transition:
        opacity 180ms ease,
        transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
        background 180ms ease,
        border-color 180ms ease,
        box-shadow 180ms ease;
      user-select: none;
      -webkit-backdrop-filter: blur(24px) saturate(1.58) brightness(1.14);
      backdrop-filter: blur(24px) saturate(1.58) brightness(1.14);
    }

    button::before {
      content: "";
      position: absolute;
      inset: 2px;
      border-radius: inherit;
      background:
        linear-gradient(118deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.22) 26%, transparent 48%),
        radial-gradient(ellipse 48% 76% at 30% 52%, rgba(var(--warm-rgb), 0.28), rgba(var(--hot-rgb), 0.18) 54%, transparent 76%),
        radial-gradient(ellipse 36% 88% at 92% 54%, rgba(2, 6, 23, 0.08), transparent 70%);
      box-shadow:
        inset 0 1px 2px rgba(255, 255, 255, 0.48),
        inset 9px 9px 22px rgba(var(--rim-rgb), 0.18),
        inset -10px -10px 22px rgba(4, 10, 38, 0.12);
      opacity: 0.92;
      pointer-events: none;
    }

    button:not(.busy)::after {
      content: "";
      position: absolute;
      left: 28px;
      top: 50%;
      width: 40px;
      height: 40px;
      border: 1px solid rgba(255, 255, 255, 0.62);
      border-radius: 999px;
      background:
        radial-gradient(circle at 44% 48%, rgba(var(--warm-rgb), 0.28), rgba(var(--hot-rgb), 0.16) 48%, rgba(255, 255, 255, 0.08) 69%, transparent 72%),
        rgba(255, 255, 255, 0.03);
      box-shadow:
        inset 9px 8px 16px rgba(var(--warm-rgb), 0.18),
        inset -8px -8px 18px rgba(4, 10, 38, 0.12),
        0 0 18px rgba(var(--warm-rgb), 0.18);
      transform: translate(-50%, -50%);
      pointer-events: none;
    }

    .button-icon,
    .button-label {
      position: relative;
      z-index: 1;
      pointer-events: none;
    }

    .button-icon {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
    }

    .button-icon svg {
      width: 24px;
      height: 24px;
      display: block;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.35;
      stroke-linecap: round;
      stroke-linejoin: round;
      filter: drop-shadow(0 1px 6px rgba(2, 6, 23, 0.28));
    }

    button.busy .button-icon {
      opacity: 0;
    }

    .button-label {
      justify-self: start;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    button:hover,
    button:focus-visible {
      opacity: 1;
      transform: translateY(-2px);
      border-color: rgba(var(--warm-rgb), 0.78);
      background:
        radial-gradient(ellipse 82% 98% at 28% 50%, rgba(var(--hot-rgb), 0.94), rgba(var(--rim-rgb), 0.7) 40%, rgba(var(--warm-rgb), 0.42) 61%, rgba(255, 255, 255, 0.16) 100%),
        linear-gradient(90deg, rgba(var(--hot-rgb), 0.58), rgba(var(--warm-rgb), 0.48) 55%, rgba(255, 255, 255, 0.28)),
        rgba(255, 255, 255, 0.18);
      box-shadow:
        0 16px 34px rgba(2, 6, 23, 0.26),
        0 0 36px rgba(var(--hot-rgb), 0.28),
        0 0 0 1px rgba(var(--warm-rgb), 0.2),
        inset 0 0 20px rgba(var(--warm-rgb), 0.26),
        inset 12px 12px 24px rgba(var(--rim-rgb), 0.22),
        inset -14px -14px 30px var(--glass-dark),
        inset 0 1px 0 rgba(255, 255, 255, 0.78),
        inset 0 -1px 0 rgba(var(--warm-rgb), 0.42);
      outline: none;
    }

    button:active {
      transform: translateY(0) scale(0.97);
      box-shadow:
        0 10px 24px rgba(2, 6, 23, 0.3),
        0 0 18px rgba(var(--hot-rgb), 0.16),
        inset 7px 7px 18px rgba(2, 6, 23, 0.24),
        inset -7px -7px 18px rgba(var(--rim-rgb), 0.18),
        inset 0 -1px 0 rgba(var(--warm-rgb), 0.18);
    }

    button.hidden {
      opacity: 0;
      transform: translateY(10px) scale(0.88);
      pointer-events: none;
    }

    :host(.pdf-open) {
      right: calc(50vw - 1px);
    }

    :host(.pdf-open) .stack {
      gap: 16px;
    }

    :host(.pdf-open) button {
      width: 26px;
      height: 46px;
      grid-template-columns: 1fr;
      column-gap: 0;
      padding: 0;
      border-radius: 999px 0 0 999px;
      border-right: 0;
      overflow: hidden;
      box-shadow:
        -8px 0 24px rgba(var(--hot-rgb), 0.2),
        0 0 18px rgba(var(--hot-rgb), 0.28),
        inset 8px 8px 18px rgba(var(--rim-rgb), 0.3),
        inset -8px -8px 18px var(--glass-dark),
        inset 0 1px 0 rgba(255, 255, 255, 0.62);
    }

    :host(.pdf-open) button::before {
      inset: 2px 0 2px 2px;
      border-radius: inherit;
      background:
        linear-gradient(118deg, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.12) 36%, transparent 62%),
        radial-gradient(ellipse 72% 88% at 36% 52%, rgba(var(--warm-rgb), 0.22), rgba(var(--hot-rgb), 0.14) 56%, transparent 82%);
    }

    :host(.pdf-open) button::after,
    :host(.pdf-open) .button-icon,
    :host(.pdf-open) .button-label {
      display: none;
    }

    :host(.pdf-open) button:hover,
    :host(.pdf-open) button:focus-visible {
      width: 32px;
      transform: translateX(-4px);
      border-color: rgba(var(--warm-rgb), 0.78);
    }

    :host(.pdf-open) button:active {
      transform: translateX(-2px) scale(0.98);
    }

    :host(.pdf-open) button.hidden {
      opacity: 0;
      transform: translateX(10px) scale(0.86);
      pointer-events: none;
    }

    button.pdfdock {
      --hot-rgb: 255, 161, 46;
      --warm-rgb: 255, 252, 200;
      --rim-rgb: 255, 222, 118;
    }

    button.pdfdock.marked {
      --hot-rgb: 255, 178, 52;
      --warm-rgb: 255, 253, 210;
      --rim-rgb: 255, 230, 130;
    }

    button.restore {
      --hot-rgb: 168, 85, 247;
      --warm-rgb: 245, 220, 255;
      --rim-rgb: 220, 190, 255;
    }

    button.restore.missing {
      --hot-rgb: 145, 108, 232;
      --warm-rgb: 232, 236, 248;
      --rim-rgb: 205, 190, 255;
      opacity: 0.78;
    }

    button.mark {
      --hot-rgb: 24, 205, 145;
      --warm-rgb: 214, 255, 236;
      --rim-rgb: 128, 240, 196;
    }

    button.mark.marked {
      --hot-rgb: 44, 218, 104;
      --warm-rgb: 224, 255, 232;
      --rim-rgb: 144, 244, 176;
    }

    button.stop {
      --hot-rgb: 255, 96, 96;
      --warm-rgb: 255, 216, 222;
      --rim-rgb: 255, 148, 166;
    }

    button.busy {
      --hot-rgb: 59, 130, 246;
      --warm-rgb: 219, 234, 254;
      --rim-rgb: 147, 197, 253;
    }

    button.busy::after {
      content: "";
      position: absolute;
      left: 28px;
      top: 50%;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 2px solid rgba(var(--warm-rgb), 0.22);
      border-top-color: rgba(var(--warm-rgb), 0.92);
      pointer-events: none;
      transform: translate(-50%, -50%);
      animation: spinRing 900ms linear infinite;
    }

    .toast {
      max-width: 220px;
      padding: 10px 12px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.78);
      color: #1e293b;
      box-shadow:
        0 14px 32px rgba(15, 23, 42, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.78);
      font-size: 12px;
      line-height: 1.4;
      opacity: 0;
      transform: translateY(6px) scale(0.98);
      transition: opacity 180ms ease, transform 180ms ease;
      pointer-events: none;
      -webkit-backdrop-filter: blur(14px) saturate(1.25);
      backdrop-filter: blur(14px) saturate(1.25);
    }

    .toast.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    @keyframes spinRing {
      to { transform: translate(-50%, -50%) rotate(360deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      button,
      button::before,
      button::after,
      .toast {
        animation: none !important;
        transition: none !important;
      }
    }
  `;

  const stack = document.createElement("div");
  stack.className = "stack";

  const toast = document.createElement("div");
  toast.className = "toast";

  const icons = {
    pdf: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>`,
    restore: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>`,
    mark: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
    top: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.8"/></svg>`,
    busy: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>`,
  };

  const setButtonContent = (button, iconName, label) => {
    button.replaceChildren();
    const icon = document.createElement("span");
    icon.className = "button-icon";
    icon.innerHTML = icons[iconName] || icons.mark;
    const text = document.createElement("span");
    text.className = "button-label";
    text.textContent = label;
    button.append(icon, text);
  };

  const markButton = document.createElement("button");
  markButton.type = "button";
  setButtonContent(markButton, "mark", "Mark");
  markButton.title = "Mark current reading position. Right-click clears the mark.";
  markButton.setAttribute("aria-label", "Mark current reading position");
  markButton.className = "mark";

  const pdfDockButton = document.createElement("button");
  pdfDockButton.type = "button";
  setButtonContent(pdfDockButton, "pdf", "PDF");
  pdfDockButton.title = "Open PDF study panel";
  pdfDockButton.setAttribute("aria-label", "Open PDF study panel");
  pdfDockButton.className = "pdfdock";

  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  setButtonContent(restoreButton, "restore", "Restore");
  restoreButton.title = "Go to marked reading position";
  restoreButton.setAttribute("aria-label", "Go to marked reading position");
  restoreButton.className = "restore missing";

  const topButton = document.createElement("button");
  topButton.type = "button";
  setButtonContent(topButton, "top", "Top");
  topButton.title = "Manually deep scroll to the first message";
  topButton.setAttribute("aria-label", "Manually deep scroll to the first message");
  topButton.className = "hidden";

  const stopButton = document.createElement("button");
  stopButton.type = "button";
  setButtonContent(stopButton, "stop", "Stop");
  stopButton.title = "Stop loading upward";
  stopButton.setAttribute("aria-label", "Stop loading upward");
  stopButton.className = "stop hidden";

  stack.append(toast, pdfDockButton, restoreButton, markButton, stopButton, topButton);
  shadow.append(style, stack);
  document.documentElement.append(host);

  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("visible"), 1800);
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalizeText = (text) => {
    return String(text || "").replace(/\s+/g, " ").trim();
  };

  const sendRuntimeMessage = (message) => {
    return new Promise((resolve, reject) => {
      const runtime = getChromeRuntime();
      if (!runtime?.sendMessage) {
        reject(new Error("Chrome runtime messaging is unavailable."));
        return;
      }
      try {
        runtime.sendMessage(message, (response) => {
          try {
            const error = runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            if (!response?.ok) {
              reject(new Error(response?.error || "Extension request failed."));
              return;
            }
            resolve(response);
          } catch (error) {
            if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
            reject(error);
          }
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
        reject(error);
      }
    });
  };

  const isVisible = (element) => {
    if (!element || element === host) return false;
    if (element === document.documentElement || element === document.body || element === document.scrollingElement) return true;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 120
      && style.display !== "none"
      && style.visibility !== "hidden";
  };

  const isScrollable = (element) => {
    if (!element || !isVisible(element)) return false;
    const delta = element.scrollHeight - element.clientHeight;
    if (delta <= MIN_SCROLL_DELTA) return false;
    if (element.scrollTop > 0) return true;
    const overflowY = getComputedStyle(element).overflowY;
    return /auto|scroll|overlay/i.test(overflowY);
  };

  let scrollablesCache = {
    at: 0,
    items: null,
  };

  const getScrollables = (options = {}) => {
    const now = Date.now();
    if (!options.exhaustive && scrollablesCache.items && now - scrollablesCache.at < 1200) {
      return scrollablesCache.items;
    }

    const fastSelector = [
      "main",
      "[role='main']",
      "[class*='scroll']",
      "[class*='conversation']",
      "[class*='chat']",
      "[data-test-id*='conversation']",
      "[data-testid*='conversation']",
    ].join(",");

    const base = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...document.querySelectorAll(fastSelector),
    ];
    if (options.exhaustive) {
      base.push(...document.querySelectorAll("*"));
    }

    const items = Array.from(new Set(base)).filter(isScrollable);
    scrollablesCache = { at: now, items };
    return items;
  };

  const getPrimaryScroller = (options = {}) => {
    const scrollables = getScrollables(options);
    return scrollables
      .slice()
      .sort((a, b) => {
        const aScore = (a.scrollTop || 0) + Math.max(0, a.scrollHeight - a.clientHeight);
        const bScore = (b.scrollTop || 0) + Math.max(0, b.scrollHeight - b.clientHeight);
        return bScore - aScore;
      })[0] || document.scrollingElement || document.documentElement;
  };

  const currentScrollTop = () => {
    const scroller = getPrimaryScroller();
    return Math.max(
      0,
      scroller?.scrollTop || 0,
      window.scrollY || 0,
      document.documentElement.scrollTop || 0,
      document.body.scrollTop || 0,
    );
  };

  const scrollEverywhere = (top, behavior = "smooth", options = {}) => {
    const targets = getScrollables(options);
    const list = targets.length ? targets : [document.scrollingElement || document.documentElement];
    for (const element of list) {
      element.scrollTo({ top, behavior });
    }
    window.scrollTo({ top, behavior });
  };

  const scrollToSavedPosition = (saved, behavior = "auto") => {
    const top = Math.max(0, Number(saved?.top) || 0);
    scrollEverywhere(top, behavior);
  };

  let currentKey = getConversationKey();
  let restoreToken = 0;
  let deepTopToken = 0;
  let markerScrollToken = 0;
  let hasMarker = false;
  let gemSyncPdfState = {
    autoSyncEnabled: false,
    deckId: "",
    pagePrompt: "",
  };
  let gemSyncReverseTimer = 0;
  let gemSyncLastReverseSignature = "";

  const getAnchorCandidates = () => {
    const selector = [
      "p",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "pre",
      "code",
      "user-query",
      "model-response",
      "message-content",
      "rich-text",
      "article",
    ].join(",");

    return Array.from(document.querySelectorAll(selector))
      .filter((element) => !host.contains(element))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalizeText(element.innerText || element.textContent || "");
        return { element, rect, text };
      })
      .filter(({ rect, text }) => {
        return rect.width > 80
          && rect.height > 8
          && rect.bottom > 72
          && rect.top < window.innerHeight - 120
          && text.length >= 40
          && text.length <= 2500
          && !/^问问 Gemini/i.test(text);
      });
  };

  const getVisibleAnchor = () => {
    const targetTop = Math.min(300, Math.max(140, window.innerHeight * 0.28));
    const candidates = getAnchorCandidates();
    const best = candidates
      .sort((a, b) => {
        const aScore = Math.abs(a.rect.top - targetTop) + Math.max(0, a.text.length - 900) / 12;
        const bScore = Math.abs(b.rect.top - targetTop) + Math.max(0, b.text.length - 900) / 12;
        return aScore - bScore;
      })[0];

    if (!best) return null;
    return {
      snippet: best.text.slice(0, 220),
      context: best.text.slice(0, 520),
      topOffset: Math.round(best.rect.top),
      savedAt: new Date().toISOString(),
    };
  };

  const findAnchorElement = (saved) => {
    const snippets = [
      saved?.anchor?.snippet,
      saved?.anchor?.context,
    ]
      .map(normalizeText)
      .filter((text) => text.length >= 40)
      .flatMap((text) => {
        return [
          text,
          text.slice(0, 180),
          text.slice(0, 120),
        ].filter((value) => value.length >= 40);
      });

    if (!snippets.length) return null;

    const selector = [
      "p",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "pre",
      "code",
      "user-query",
      "model-response",
      "message-content",
      "rich-text",
      "article",
    ].join(",");

    const matches = Array.from(document.querySelectorAll(selector))
      .filter((element) => !host.contains(element))
      .map((element) => {
        return {
          element,
          text: normalizeText(element.innerText || element.textContent || ""),
        };
      })
      .filter(({ text }) => snippets.some((snippet) => text.includes(snippet)))
      .sort((a, b) => a.text.length - b.text.length);

    return matches[0]?.element || null;
  };

  const isDocumentScroller = (element) => {
    return !element
      || element === window
      || element === document
      || element === document.scrollingElement
      || element === document.documentElement
      || element === document.body;
  };

  const topOverlayInset = () => {
    const leftPaneWidth = document.documentElement.classList.contains(`${HOST_ID}-pdf-open`)
      ? Math.max(1, window.innerWidth * 0.5)
      : window.innerWidth;
    const sampleXs = [
      Math.max(24, Math.min(360, leftPaneWidth - 24)),
      Math.max(24, Math.min(leftPaneWidth - 24, Math.round(leftPaneWidth * 0.5))),
    ];
    const maxProbeY = Math.min(160, Math.round(window.innerHeight * 0.35));
    let inset = 0;

    for (const x of sampleXs) {
      for (let y = 0; y <= maxProbeY; y += 12) {
        let node = document.elementFromPoint(x, y);
        for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
          if (host.contains(node)) break;
          const rect = node.getBoundingClientRect?.();
          if (!rect || rect.height <= 0 || rect.height > 180 || rect.width < 80) continue;
          if (rect.top > y + 1 || rect.bottom <= y) continue;
          const style = window.getComputedStyle(node);
          if (style.position === "fixed" || style.position === "sticky") {
            inset = Math.max(inset, rect.bottom);
            break;
          }
        }
      }
    }

    return Math.min(140, Math.max(0, Math.round(inset)));
  };

  const scrollElementToTop = (element, behavior = "auto") => {
    if (!element?.getBoundingClientRect) return;
    const scroller = getPrimaryScroller();
    const rect = element.getBoundingClientRect();
    const overlay = topOverlayInset();

    if (!isDocumentScroller(scroller)) {
      const scrollerRect = scroller.getBoundingClientRect();
      const margin = (scrollerRect.top <= 4 ? overlay : 0) + SYNC_TOP_MARGIN_PX;
      const top = Math.max(0, Math.round((scroller.scrollTop || 0) + rect.top - scrollerRect.top - margin));
      scroller.scrollTo({ top, behavior });
      return;
    }

    const top = Math.max(0, Math.round(currentScrollTop() + rect.top - overlay - SYNC_TOP_MARGIN_PX));
    window.scrollTo({ top, behavior });
    document.documentElement.scrollTop = top;
    document.body.scrollTop = top;
  };

  const scrollElementIntoReadingView = (element, behavior = "smooth", options = {}) => {
    const target = options.preferMessageTop ? expandPromptRootForReading(element) : element;
    const firstBehavior = behavior === "smooth" && !options.forceAuto ? "smooth" : "auto";
    const align = (mode = "auto") => scrollElementToTop(target, mode);

    align(firstBehavior);
    requestAnimationFrame(() => align("auto"));
    setTimeout(() => align("auto"), firstBehavior === "smooth" ? 260 : 80);
    setTimeout(() => align("auto"), firstBehavior === "smooth" ? 620 : 240);
    setTimeout(() => align("auto"), firstBehavior === "smooth" ? 980 : 520);
  };

  const applyStyles = (element, styles) => {
    Object.assign(element.style, styles);
  };

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const scrollPrimaryBy = async (delta) => {
    const before = currentScrollTop();
    const scroller = getPrimaryScroller();
    const target = before + delta;
    scroller?.scrollTo({ top: target, behavior: "auto" });
    window.scrollTo({ top: target, behavior: "auto" });
    await sleep(750);
    await nextFrame();
    return Math.max(0, currentScrollTop() - before);
  };

  const dispatchScrollSignals = (target, deltaY) => {
    const eventTarget = target || document.scrollingElement || document.documentElement;
    try {
      eventTarget.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
        deltaMode: 0,
      }));
    } catch {
      // Some pages restrict synthetic WheelEvent construction; scroll calls below still run.
    }

    try {
      eventTarget.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new Event("scroll"));
    } catch {
      // Ignore synthetic event failures.
    }
  };

  const pressOlderLoadKeys = () => {
    for (const key of ["Home", "PageUp"]) {
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
          code: key,
        }));
      } catch {
        // Ignore synthetic key failures.
      }
    }
  };

  const triggerOlderMessageLoad = async (attempt = 0) => {
    const scroller = getPrimaryScroller({ exhaustive: true });
    const targets = getScrollables({ exhaustive: true });
    const list = targets.length ? targets : [scroller, document.scrollingElement, document.documentElement].filter(Boolean);

    for (const element of list) {
      const top = Math.max(0, Number(element.scrollTop) || 0);
      element.scrollTo({ top: 0, behavior: "auto" });
      dispatchScrollSignals(element, -1800);

      if (top <= 2 && attempt % 4 === 3) {
        element.scrollTo({ top: OLDER_LOAD_NUDGE_PX, behavior: "auto" });
        dispatchScrollSignals(element, 360);
        await sleep(120);
        element.scrollTo({ top: 0, behavior: "auto" });
        dispatchScrollSignals(element, -2200);
      }
    }

    window.scrollTo({ top: 0, behavior: "auto" });
    pressOlderLoadKeys();
    await sleep(attempt < 8 ? 950 : 1450);
  };

  const getDeepTopSignature = () => {
    const scrollables = getScrollables({ exhaustive: true });
    const primary = getPrimaryScroller({ exhaustive: true });
    const maxHeight = Math.max(0, ...scrollables.map((element) => element.scrollHeight || 0));
    const text = (document.body.innerText || "").slice(0, 2200);
    const nodeCount = document.querySelectorAll("article, user-query, model-response, message-content, rich-text, img").length;
    return {
      top: Math.round(primary?.scrollTop || currentScrollTop()),
      maxHeight,
      nodeCount,
      imageCount: document.images.length,
      text,
    };
  };

  const scrollToDeepTop = async ({ behavior = "smooth", silent = false, restoreId = null } = {}) => {
    const runId = ++deepTopToken;
    let stableRounds = 0;
    let previousSignature = "";
    const startedAt = Date.now();

    topButton.classList.add("busy");
    topButton.classList.remove("hidden");
    updateVisibility();
    setButtonContent(topButton, "busy", "Busy");
    if (!silent) showToast("Loading earliest messages...");

    while (
      runId === deepTopToken
      && (restoreId === null || restoreId === restoreToken)
      && Date.now() - startedAt < DEEP_TOP_TIMEOUT_MS
    ) {
      scrollEverywhere(0, behavior);
      await sleep(900);
      scrollEverywhere(0, "auto");
      await sleep(450);

      const signature = getDeepTopSignature();
      const signatureKey = JSON.stringify({
        maxHeight: signature.maxHeight,
        nodeCount: signature.nodeCount,
        imageCount: signature.imageCount,
        text: signature.text,
      });

      if (signature.top > 4) {
        stableRounds = 0;
        previousSignature = "";
      } else if (signatureKey === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousSignature = signatureKey;
      }

      if (stableRounds >= 4) break;
      behavior = "auto";
    }

    const stillActive = runId === deepTopToken && (restoreId === null || restoreId === restoreToken);
    if (stillActive) {
      scrollEverywhere(0, "auto");
      topButton.classList.remove("busy");
      setButtonContent(topButton, "top", "Top");
      if (!silent) showToast("Reached earliest message.");
      updateVisibility();
    }
  };

  const updateMarkButton = () => {
    markButton.classList.toggle("marked", hasMarker);
    restoreButton.classList.toggle("missing", !hasMarker);
    markButton.title = hasMarker
      ? "Update current reading position. Right-click clears the mark."
      : "Mark current reading position. Right-click clears the mark.";
    restoreButton.title = hasMarker
      ? "Go to marked reading position"
      : "No marker yet";
  };

  const readMarker = async (key) => {
    return key ? await storage.get(key) : null;
  };

  const scrollToMarker = async ({ silent = false, restoreId = null } = {}) => {
    const key = getConversationKey();
    const saved = await readMarker(key);
    if (!saved) {
      hasMarker = false;
      updateMarkButton();
      if (!silent) showToast("No marker for this conversation.");
      return false;
    }

    hasMarker = true;
    updateMarkButton();

    const alreadyLoaded = findAnchorElement(saved);
    if (alreadyLoaded) {
      scrollElementIntoReadingView(alreadyLoaded, "smooth");
      if (!silent) showToast("Jumped to marker.");
      return true;
    }

    if (!saved.anchor?.snippet) {
      scrollToSavedPosition(saved, "smooth");
      if (!silent) showToast("Jumped to saved scroll position.");
      return true;
    }

    const runId = ++markerScrollToken;
    deepTopToken += 1;
    let stableRounds = 0;
    let previousSignature = "";
    let found = null;
    const startedAt = Date.now();

    restoreButton.classList.add("busy");
    setButtonContent(restoreButton, "busy", "Busy");
    updateVisibility();
    if (!silent) showToast("Loading toward marker...");

    while (
      runId === markerScrollToken
      && (restoreId === null || restoreId === restoreToken)
      && Date.now() - startedAt < MARKER_SCROLL_TIMEOUT_MS
    ) {
      found = findAnchorElement(saved);
      if (found) break;

      scrollEverywhere(0, "auto");
      await sleep(900);
      scrollEverywhere(0, "auto");
      await sleep(450);

      const signature = getDeepTopSignature();
      const signatureKey = JSON.stringify({
        maxHeight: signature.maxHeight,
        nodeCount: signature.nodeCount,
        imageCount: signature.imageCount,
        text: signature.text,
      });

      if (signature.top > 4) {
        stableRounds = 0;
        previousSignature = "";
      } else if (signatureKey === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousSignature = signatureKey;
      }

      if (stableRounds >= 4) break;
    }

    const stillActive = runId === markerScrollToken && (restoreId === null || restoreId === restoreToken);
    if (!stillActive) {
      return false;
    }

    if (found) {
      scrollElementIntoReadingView(found, "smooth");
      if (!silent) showToast("Jumped to marker.");
    } else {
      scrollToSavedPosition(saved, "smooth");
      if (!silent) showToast("Marker text not loaded; used saved position.");
    }

    restoreButton.classList.remove("busy");
    setButtonContent(restoreButton, "restore", "Restore");
    updateMarkButton();
    updateVisibility();

    return !!found;
  };

  const elementDocumentTop = (element) => {
    return Math.round((element?.getBoundingClientRect?.().top || 0) + currentScrollTop());
  };

  const messageRootFor = (element) => {
    return element.closest?.([
      "user-query",
      "[data-test-id*='user']",
      "[data-testid*='user']",
      "[class*='user-query']",
      "article",
      "[role='listitem']",
    ].join(",")) || element;
  };

  const hasAttachedImage = (element) => {
    if (!element) return false;
    return !!element.querySelector([
      "img",
      "picture",
      "canvas",
      "[data-test-id*='image']",
      "[data-testid*='image']",
      "[data-test-id*='attachment']",
      "[data-testid*='attachment']",
      "[aria-label*='图片']",
      "[aria-label*='图像']",
      "[aria-label*='image' i]",
      "[aria-label*='attachment' i]",
      "[role='img']",
    ].join(","));
  };

  const expandPromptRootForReading = (root) => {
    if (!root?.parentElement) return root;
    const rootText = normalizeText(root.innerText || root.textContent || "");
    const rootSnippet = rootText.slice(0, Math.min(120, Math.max(40, rootText.length)));
    const rootRect = root.getBoundingClientRect?.();
    let best = root;
    let current = root;

    for (let depth = 0; depth < 5; depth += 1) {
      const parent = current.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement || host.contains(parent)) break;

      const parentRect = parent.getBoundingClientRect?.();
      if (!parentRect || parentRect.height <= 0) break;

      const parentText = normalizeText(parent.innerText || parent.textContent || "");
      if (rootSnippet && !parentText.includes(rootSnippet)) break;

      const currentRect = current.getBoundingClientRect?.();
      const topGap = Math.max(0, (currentRect?.top || rootRect?.top || 0) - parentRect.top);
      const focusedText = !rootText || parentText.length <= Math.max(2800, rootText.length + 1600);
      const focusedHeight = parentRect.height <= Math.max(1400, (rootRect?.height || 0) + 1100);
      const className = String(parent.className || "");
      const usefulContainer = hasAttachedImage(parent)
        || parent.matches?.("article,[role='listitem']")
        || /user|query|message|turn|conversation/i.test(className);

      if (!usefulContainer || !focusedText || !focusedHeight || topGap > 700) break;

      best = parent;
      current = parent;
    }

    return best;
  };

  const pptPromptVariants = (prompt) => {
    const base = normalizeText(prompt || "请详细讲解这一面PPT");
    const variants = new Set([base]);
    for (const text of [...variants]) {
      variants.add(text.replace("这一面PPT", "这一页PPT"));
      variants.add(text.replace("这一页PPT", "这一面PPT"));
      variants.add(text.replace("这一面 PPT", "这一页 PPT"));
      variants.add(text.replace("这一页 PPT", "这一面 PPT"));
    }
    return [...variants].filter(Boolean);
  };

  const includesAnyPptPrompt = (text, promptTexts) => {
    return promptTexts.some((promptText) => promptText && text.includes(promptText));
  };

  const addPptPromptRoot = (roots, seen, element, promptTexts) => {
    if (!element || host.contains(element)) return;
    const text = normalizeText(element.textContent || "");
    if (!includesAnyPptPrompt(text, promptTexts)) return;
    if (text.length > 2600 && element.tagName.toLowerCase() !== "user-query") return;

    const root = expandPromptRootForReading(messageRootFor(element));
    if (!root || host.contains(root) || seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  };

  const collectPromptRootsFromTextNodes = (roots, seen, promptTexts) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || host.contains(parent)) return NodeFilter.FILTER_REJECT;
        return includesAnyPptPrompt(normalizeText(node.nodeValue || ""), promptTexts)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });

    let count = 0;
    while (count < 80) {
      const node = walker.nextNode();
      if (!node) break;
      addPptPromptRoot(roots, seen, node.parentElement, promptTexts);
      count += 1;
    }
  };

  const collectPptPromptCandidates = (prompt) => {
    const promptTexts = pptPromptVariants(prompt);
    const selector = [
      "user-query",
      "[data-test-id*='user']",
      "[data-testid*='user']",
      "[class*='user-query']",
      "[class*='query-text']",
      "[class*='query-content']",
      "[aria-label*='用户']",
      "[aria-label*='User' i]",
    ].join(",");

    const roots = [];
    const seen = new Set();
    for (const element of document.querySelectorAll(selector)) {
      addPptPromptRoot(roots, seen, element, promptTexts);
    }
    if (!roots.length) collectPromptRootsFromTextNodes(roots, seen, promptTexts);

    const scrollTop = currentScrollTop();
    const candidates = roots
      .map((root) => ({
        root,
        top: Math.round((root.getBoundingClientRect?.().top || 0) + scrollTop),
        text: normalizeText(root.innerText || root.textContent || ""),
        hasImage: hasAttachedImage(root),
      }))
      .filter((item) => includesAnyPptPrompt(item.text, promptTexts))
      .sort((a, b) => a.top - b.top);

    const deduped = [];
    for (const candidate of candidates) {
      const duplicate = deduped.some((existing) => {
        return existing.root === candidate.root
          || existing.root.contains(candidate.root)
          || candidate.root.contains(existing.root)
          || Math.abs(existing.top - candidate.top) < 8;
      });
      if (!duplicate) deduped.push(candidate);
    }

    return deduped;
  };

  const visiblePptPosition = (prompt) => {
    const all = collectPptPromptCandidates(prompt);
    if (!all.length) return null;

    const image = all.filter((candidate) => candidate.hasImage);
    const anchor = currentScrollTop() + topOverlayInset() + Math.min(260, Math.max(120, window.innerHeight * 0.22));
    const prior = all.filter((candidate) => candidate.top <= anchor).pop();
    const candidate = prior || all
      .slice()
      .sort((a, b) => Math.abs(a.top - anchor) - Math.abs(b.top - anchor))[0];
    const promptIndex = all.findIndex((item) => item.root === candidate.root) + 1;
    const imagePromptIndex = image.findIndex((item) => item.root === candidate.root) + 1;

    return {
      candidate,
      promptIndex: promptIndex || null,
      imagePromptIndex: imagePromptIndex || null,
      promptCount: all.length,
      imagePromptCount: image.length,
    };
  };

  const sendGeminiVisiblePageToPdf = (position) => {
    if (!pdfDock || !position) return;
    const iframe = pdfDock.querySelector("iframe");
    if (!iframe?.contentWindow) return;

    iframe.contentWindow.postMessage({
      source: "gemsync-parent",
      type: "gemsync:gemini-visible-page",
      payload: {
        deckId: gemSyncPdfState.deckId || "",
        conversationId: getConversationId(),
        promptIndex: position.promptIndex,
        imagePromptIndex: position.imagePromptIndex,
        promptCount: position.promptCount,
        imagePromptCount: position.imagePromptCount,
      },
    }, new URL(iframe.src).origin);
  };

  const scheduleGeminiToPdfSync = () => {
    if (!pdfDock || !gemSyncPdfState.autoSyncEnabled) return;
    clearTimeout(gemSyncReverseTimer);
    gemSyncReverseTimer = setTimeout(() => {
      const position = visiblePptPosition(gemSyncPdfState.pagePrompt);
      if (!position) return;
      const signature = [
        gemSyncPdfState.deckId || "",
        getConversationId(),
        position.promptIndex || 0,
        position.imagePromptIndex || 0,
      ].join(":");
      if (signature === gemSyncLastReverseSignature) return;
      gemSyncLastReverseSignature = signature;
      sendGeminiVisiblePageToPdf(position);
    }, 420);
  };

  const selectPptCandidate = (payload, options = {}) => {
    const pageNumber = Math.max(1, Number(payload?.pageNumber) || 1);
    const binding = payload?.binding || null;
    const all = collectPptPromptCandidates(payload?.pagePrompt);
    const image = all.filter((candidate) => candidate.hasImage);
    const targetImagePromptIndex = Number(binding?.targetImagePromptIndex) || 0;
    const targetPromptIndex = Number(binding?.targetPromptIndex) || 0;
    const allowAbsoluteFallback = options.allowAbsoluteFallback ?? true;

    if (targetImagePromptIndex > 0 && image.length >= targetImagePromptIndex) {
      return {
        candidate: image[targetImagePromptIndex - 1],
        all,
        image,
        mode: "calibrated-image",
        target: targetImagePromptIndex,
      };
    }

    if (targetPromptIndex > 0 && all.length >= targetPromptIndex) {
      return {
        candidate: all[targetPromptIndex - 1],
        all,
        image,
        mode: "calibrated",
        target: targetPromptIndex,
      };
    }

    if (allowAbsoluteFallback && image.length >= pageNumber) {
      return {
        candidate: image[pageNumber - 1],
        all,
        image,
        mode: "image",
        target: pageNumber,
      };
    }

    if (allowAbsoluteFallback && all.length >= pageNumber) {
      return {
        candidate: all[pageNumber - 1],
        all,
        image,
        mode: "all",
        target: pageNumber,
      };
    }

    return {
      candidate: null,
      all,
      image,
      mode: image.length ? "image" : "all",
      target: Math.max(targetImagePromptIndex, targetPromptIndex, pageNumber),
    };
  };

  const findPptCandidateWithLoading = async (payload) => {
    const runId = ++markerScrollToken;
    let previousSignature = "";
    let stableRounds = 0;
    let attempts = 0;
    const startedAt = Date.now();
    const hasCalibratedIndex = !!(
      Number(payload?.binding?.targetImagePromptIndex)
      || Number(payload?.binding?.targetPromptIndex)
    );
    const isManualSync = payload?.reason !== "auto";

    restoreButton.classList.add("busy");
    setButtonContent(restoreButton, "busy", "Busy");
    updateVisibility();

    while (runId === markerScrollToken && Date.now() - startedAt < MARKER_SCROLL_TIMEOUT_MS) {
      const trustAbsolutePageNumber = hasCalibratedIndex
        || isManualSync
        || (attempts >= 18 && stableRounds >= 8)
        || Date.now() - startedAt > 55000;
      const result = selectPptCandidate(payload, {
        allowAbsoluteFallback: trustAbsolutePageNumber,
      });
      if (result.candidate) {
        restoreButton.classList.remove("busy");
        setButtonContent(restoreButton, "restore", "Restore");
        updateMarkButton();
        updateVisibility();
        return result;
      }

      if (attempts % 8 === 0) {
        const found = result.image.length || result.all.length;
        const target = result.target || payload?.pageNumber || 1;
        showToast(`Loading older Gemini messages... ${found}/${target}`);
      }

      await triggerOlderMessageLoad(attempts);
      attempts += 1;

      const signature = getDeepTopSignature();
      const signatureKey = JSON.stringify({
        top: signature.top,
        maxHeight: signature.maxHeight,
        nodeCount: signature.nodeCount,
        imageCount: signature.imageCount,
        allCount: result.all.length,
        imageCount2: result.image.length,
        text: signature.text,
      });

      if (signatureKey === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousSignature = signatureKey;
      }

      if (stableRounds >= 10) {
        await triggerOlderMessageLoad(attempts);
        stableRounds = 0;
        previousSignature = "";
      }
    }

    restoreButton.classList.remove("busy");
    setButtonContent(restoreButton, "restore", "Restore");
    updateMarkButton();
    updateVisibility();
    return selectPptCandidate(payload);
  };

  const scrollToBindingAnchor = async (binding, options = {}) => {
    if (!binding?.anchor) return false;

    let found = findAnchorElement({ anchor: binding.anchor });
    if (found) {
      scrollElementIntoReadingView(found, options.behavior || "auto", {
        preferMessageTop: !!options.preferMessageTop,
        forceAuto: options.behavior !== "smooth",
      });
      return true;
    }

    const runId = ++markerScrollToken;
    let stableRounds = 0;
    let previousSignature = "";
    const startedAt = Date.now();

    restoreButton.classList.add("busy");
    setButtonContent(restoreButton, "busy", "Busy");
    updateVisibility();

    while (runId === markerScrollToken && Date.now() - startedAt < MARKER_SCROLL_TIMEOUT_MS) {
      found = findAnchorElement({ anchor: binding.anchor });
      if (found) break;

      scrollEverywhere(0, "auto");
      await sleep(850);
      scrollEverywhere(0, "auto");
      await sleep(420);

      const signature = getDeepTopSignature();
      const signatureKey = JSON.stringify({
        top: signature.top,
        maxHeight: signature.maxHeight,
        nodeCount: signature.nodeCount,
        imageCount: signature.imageCount,
        text: signature.text,
      });
      if (signatureKey === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousSignature = signatureKey;
      }
      if (stableRounds >= 3) break;
    }

    restoreButton.classList.remove("busy");
    setButtonContent(restoreButton, "restore", "Restore");
    updateMarkButton();
    updateVisibility();

    if (found) {
      scrollElementIntoReadingView(found, options.behavior || "auto", {
        preferMessageTop: !!options.preferMessageTop,
        forceAuto: options.behavior !== "smooth",
      });
      return true;
    }

    return false;
  };

  const nearestPromptCandidate = (prompt) => {
    const all = collectPptPromptCandidates(prompt);
    const image = all.filter((candidate) => candidate.hasImage);
    if (!all.length) {
      return { all, image, candidate: null, promptIndex: null, imagePromptIndex: null };
    }

    const center = currentScrollTop() + window.innerHeight * 0.48;
    const prior = all.filter((candidate) => candidate.top <= center + 220).pop();
    const candidate = prior || all
      .slice()
      .sort((a, b) => Math.abs(a.top - center) - Math.abs(b.top - center))[0];

    return {
      all,
      image,
      candidate,
      promptIndex: all.findIndex((item) => item.root === candidate.root) + 1,
      imagePromptIndex: image.findIndex((item) => item.root === candidate.root) + 1 || null,
    };
  };

  const buildGemSyncBinding = (payload) => {
    const scroller = getPrimaryScroller();
    const promptInfo = nearestPromptCandidate(payload?.pagePrompt);
    return {
      top: Math.max(0, scroller.scrollTop || currentScrollTop()),
      anchor: getVisibleAnchor(),
      href: location.href,
      title: document.title,
      promptIndex: promptInfo.promptIndex,
      imagePromptIndex: promptInfo.imagePromptIndex,
      promptCount: promptInfo.all.length,
      imagePromptCount: promptInfo.image.length,
      promptSnippet: promptInfo.candidate?.text?.slice(0, 220) || "",
      savedAt: new Date().toISOString(),
    };
  };

  const handleGemSyncBind = async (payload) => {
    const binding = buildGemSyncBinding(payload);
    showToast(`Page ${payload?.pageNumber || ""} calibrated.`);
    return { ok: true, binding };
  };

  const handleGemSyncPage = async (payload) => {
    const pageNumber = Math.max(1, Number(payload?.pageNumber) || 1);
    const binding = payload?.binding || null;
    const deep = !!payload?.deep;
    showToast(deep ? `Deep syncing PDF page ${pageNumber}...` : `Syncing PDF page ${pageNumber}...`);

    if (binding?.pageOffset === 0 && binding.anchor) {
      const loadedAnchor = findAnchorElement({ anchor: binding.anchor });
      if (loadedAnchor) {
        scrollElementIntoReadingView(loadedAnchor, "auto", { preferMessageTop: true });
        showToast(`Page ${pageNumber}: calibrated position.`);
        return { ok: true, usedBinding: true };
      }

      const anchored = deep
        ? await scrollToBindingAnchor(binding, { behavior: "auto", preferMessageTop: true })
        : false;
      if (anchored) {
        showToast(`Page ${pageNumber}: calibrated position.`);
        return { ok: true, usedBinding: true };
      }
    }

    if (binding?.pageOffset === 0 && binding?.top && !binding?.targetPromptIndex && !binding?.targetImagePromptIndex) {
      scrollToSavedPosition(binding, "auto");
      showToast(`Page ${pageNumber}: saved position.`);
      return { ok: true, usedBinding: true };
    }

    const result = deep
      ? await findPptCandidateWithLoading(payload)
      : selectPptCandidate(payload, { allowAbsoluteFallback: true });
    if (!result.candidate) {
      showToast(`Only found ${result.image.length || result.all.length} PPT prompts. Calibrate this page.`);
      return {
        ok: false,
        error: deep
          ? `Gemini 里只找到 ${result.image.length || result.all.length} 条 PPT 提问。可能有漏发页，请在这一页点“校准本页”。`
          : `当前已加载的 Gemini 聊天里没找到第 ${pageNumber} 页。可以先点“深度同步”，找到后再点“校准本页”。`,
        foundPrompts: result.all.length,
        foundImagePrompts: result.image.length,
      };
    }

    scrollElementIntoReadingView(result.candidate.root, "auto", { preferMessageTop: true });
    const promptIndex = result.all.findIndex((item) => item.root === result.candidate.root) + 1;
    const imagePromptIndex = result.image.findIndex((item) => item.root === result.candidate.root) + 1;
    showToast(`Page ${pageNumber}: Gemini synced.`);
    return {
      ok: true,
      usedBinding: result.mode.startsWith("calibrated"),
      mode: result.mode,
      foundPrompts: result.all.length,
      foundImagePrompts: result.image.length,
      promptIndex: promptIndex || null,
      imagePromptIndex: imagePromptIndex || null,
      target: result.target,
    };
  };

  let pdfDock = null;
  let pdfDockStyle = null;

  const ensurePdfDockStyle = () => {
    if (pdfDockStyle) return;
    pdfDockStyle = document.createElement("style");
    pdfDockStyle.id = `${HOST_ID}-pdf-style`;
    pdfDockStyle.textContent = `
      html.${HOST_ID}-pdf-open {
        --gemsync-pdf-width: 50vw;
      }

      html.${HOST_ID}-pdf-open body {
        width: calc(100vw - var(--gemsync-pdf-width)) !important;
        max-width: calc(100vw - var(--gemsync-pdf-width)) !important;
        overflow-x: hidden !important;
      }

      #${HOST_ID}-pdf-dock {
        position: fixed;
        inset: 0 0 0 auto;
        width: var(--gemsync-pdf-width);
        height: 100vh;
        z-index: 2147483000;
        display: grid;
        grid-template-rows: 42px minmax(0, 1fr);
        border-left: 1px solid rgba(148, 163, 184, 0.32);
        background: rgba(246, 248, 251, 0.82);
        box-shadow: -18px 0 42px rgba(15, 23, 42, 0.2);
        font-family: Google Sans, Roboto, Arial, sans-serif;
        -webkit-backdrop-filter: blur(18px) saturate(1.12);
        backdrop-filter: blur(18px) saturate(1.12);
      }

      #${HOST_ID}-pdf-dock .gemsync-dock-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 6px 8px 6px 12px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.26);
        background: rgba(255, 255, 255, 0.66);
        color: #1e293b;
        -webkit-backdrop-filter: blur(16px) saturate(1.12);
        backdrop-filter: blur(16px) saturate(1.12);
      }

      #${HOST_ID}-pdf-dock .gemsync-dock-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 700;
      }

      #${HOST_ID}-pdf-dock .gemsync-dock-spacer {
        flex: 1;
      }

      #${HOST_ID}-pdf-dock button {
        height: 30px;
        min-width: 42px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.68);
        color: #1e293b;
        cursor: pointer;
        font: 700 13px Google Sans, Roboto, Arial, sans-serif;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
        transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        -webkit-backdrop-filter: blur(14px) saturate(1.12);
        backdrop-filter: blur(14px) saturate(1.12);
      }

      #${HOST_ID}-pdf-dock button:hover,
      #${HOST_ID}-pdf-dock button:focus-visible {
        border-color: rgba(100, 116, 139, 0.36);
        background: rgba(255, 255, 255, 0.86);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.78);
        transform: translateY(-1px);
        outline: none;
      }

      #${HOST_ID}-pdf-dock button:active {
        transform: translateY(0) scale(0.98);
        box-shadow: 0 2px 7px rgba(15, 23, 42, 0.12), inset 0 1px 3px rgba(15, 23, 42, 0.12);
      }

      #${HOST_ID}-pdf-dock iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
      }
    `;
    document.documentElement.append(pdfDockStyle);
  };

  const geminiConversationIdFromUrl = (url) => {
    try {
      return new URL(url, location.href).pathname.match(/^\/app\/([^/?#]+)/)?.[1] || "";
    } catch {
      return "";
    }
  };

  const getGemSyncDeck = async (preferredDeckId = "", preferredSubjectId = "") => {
    const conversationId = getConversationId();
    try {
      const configs = await getGemSyncConfigs();
      for (const { subject, config } of configs) {
        if (preferredSubjectId && subject.id !== preferredSubjectId) continue;
        const deck = (config.decks || []).find((item) => item.id === preferredDeckId)
          || (config.decks || []).find((item) => item.conversationId === conversationId);
        if (deck) return { ...deck, subjectId: subject.id, subjectTitle: subject.title };
      }
      const first = configs[0];
      const deck = first?.config?.decks?.[0];
      return deck
        ? { ...deck, subjectId: first.subject.id, subjectTitle: first.subject.title }
        : { id: "deck01", title: "PDF" };
    } catch (error) {
      showToast("PDF config not available.");
      return { id: "deck01", title: "PDF" };
    }
  };

  const getGemSyncDeckForCurrentChat = async () => getGemSyncDeck("");

  const setPdfDockOpen = (open) => {
    document.documentElement.classList.toggle(`${HOST_ID}-pdf-open`, open);
    host.classList.toggle("pdf-open", open);
    pdfDockButton.classList.toggle("marked", open);
    pdfDockButton.title = open ? "Close PDF study panel" : "Open PDF study panel";
    if (open) {
      host.style.right = "calc(50vw - 1px)";
    } else {
      host.style.right = "";
    }
  };

  const closePdfDock = () => {
    pdfDock?.remove();
    pdfDock = null;
    setPdfDockOpen(false);
  };

  const pdfDockUrlFor = (deck, page = 1) => {
    return getGemSyncPanelUrl({ subjectId: deck?.subjectId || "", deckId: deck?.id || "deck01", page });
  };

  const updatePdfDockDeck = (deck, page = 1) => {
    if (!pdfDock) return;
    const title = pdfDock.querySelector(".gemsync-dock-title");
    const iframe = pdfDock.querySelector("iframe");
    if (title) {
      title.textContent = deck?.title ? `PDF: ${deck.title}` : "PDF";
    }
    if (iframe) {
      iframe.src = pdfDockUrlFor(deck, page);
    }
  };

  const openPdfDock = async (options = {}) => {
    const deck = await getGemSyncDeck(options.deckId || "", options.subjectId || "");
    const page = Math.max(1, Number(options.page) || 1);

    if (pdfDock) {
      updatePdfDockDeck(deck, page);
      setPdfDockOpen(true);
      return;
    }

    ensurePdfDockStyle();
    const dock = document.createElement("section");
    dock.id = `${HOST_ID}-pdf-dock`;
    dock.setAttribute("aria-label", "GemSync PDF study panel");

    const bar = document.createElement("div");
    bar.className = "gemsync-dock-bar";

    const title = document.createElement("div");
    title.className = "gemsync-dock-title";
    title.textContent = deck.title ? `PDF: ${deck.title}` : "PDF";

    const spacer = document.createElement("div");
    spacer.className = "gemsync-dock-spacer";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "刷新";
    refresh.title = "Reload PDF panel";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Close PDF panel";

    const iframe = document.createElement("iframe");
    iframe.src = pdfDockUrlFor(deck, page);
    iframe.title = "GemSync PDF";

    refresh.addEventListener("click", () => {
      iframe.src = iframe.src;
    });
    close.addEventListener("click", closePdfDock);

    bar.append(title, spacer, refresh, close);
    dock.append(bar, iframe);
    document.documentElement.append(dock);
    pdfDock = dock;
    setPdfDockOpen(true);
    showToast("PDF panel opened.");
  };

  const rememberPendingPdfDock = (payload) => {
    const conversationId = payload?.conversationId || geminiConversationIdFromUrl(payload?.geminiUrl || "");
    try {
      localStorage.setItem(GEMSYNC_PENDING_DOCK_KEY, JSON.stringify({
        subjectId: payload?.subjectId || "",
        deckId: payload?.deckId || "",
        page: Math.max(1, Number(payload?.pageNumber) || 1),
        conversationId,
        savedAt: Date.now(),
        expiresAt: Date.now() + 90000,
      }));
    } catch {
      // The dock can still be opened manually if storage is unavailable.
    }
  };

  const restorePendingPdfDock = async () => {
    const pending = readLocalJson(GEMSYNC_PENDING_DOCK_KEY);
    if (!pending) return false;

    if (Number(pending.expiresAt) && Date.now() > Number(pending.expiresAt)) {
      localStorage.removeItem(GEMSYNC_PENDING_DOCK_KEY);
      return false;
    }

    const targetConversationId = pending.conversationId || "";
    const currentConversationId = getConversationId();
    if (targetConversationId && currentConversationId !== targetConversationId) {
      return false;
    }

    localStorage.removeItem(GEMSYNC_PENDING_DOCK_KEY);
    await openPdfDock({ subjectId: pending.subjectId, deckId: pending.deckId, page: pending.page || 1 });
    return true;
  };

  const handleGemSyncOpenGemini = async (payload) => {
    if (!payload?.geminiUrl) {
      return { ok: false, error: "This deck has no Gemini URL." };
    }

    rememberPendingPdfDock(payload);
    const targetConversationId = payload.conversationId || geminiConversationIdFromUrl(payload.geminiUrl);
    if (targetConversationId && targetConversationId === getConversationId()) {
      await openPdfDock({ subjectId: payload.subjectId, deckId: payload.deckId, page: payload.pageNumber || 1 });
      showToast("Gemini chat already open.");
      return { ok: true, alreadyOpen: true };
    }

    showToast(`Opening ${payload.deckTitle || "Gemini chat"}...`);
    setTimeout(() => {
      location.assign(payload.geminiUrl);
    }, 80);
    return { ok: true, navigating: true };
  };

  const togglePdfDock = () => {
    if (pdfDock) {
      closePdfDock();
    } else {
      openPdfDock();
    }
  };

  const respondToGemSyncFrame = (event, id, result) => {
    try {
      event.source?.postMessage({
        source: "gemsync-parent",
        id,
        ...result,
      }, event.origin || "*");
    } catch {
      // If the iframe disappeared, there is nothing useful to report.
    }
  };

  const handleGemSyncFrameMessage = async (event) => {
    const message = event.data;
    if (message?.source !== "gemsync-app-iframe") return;
    if (!isGemSyncFrameOrigin(event.origin)) return;
    if (message.type === "gemsync:pdf-state") {
      gemSyncPdfState = {
        ...gemSyncPdfState,
        ...(message.payload || {}),
        autoSyncEnabled: !!message.payload?.autoSyncEnabled,
      };
      if (gemSyncPdfState.autoSyncEnabled) scheduleGeminiToPdfSync();
      return;
    }
    if (!message.id) return;

    try {
      let result;
      if (message.type === "gemsync:sync-page") {
        result = await handleGemSyncPage(message.payload);
      } else if (message.type === "gemsync:bind-page") {
        result = await handleGemSyncBind(message.payload);
      } else if (message.type === "gemsync:open-gemini") {
        result = await handleGemSyncOpenGemini(message.payload);
      } else {
        result = { ok: false, error: `Unknown message: ${message.type}` };
      }
      respondToGemSyncFrame(event, message.id, result);
    } catch (error) {
      respondToGemSyncFrame(event, message.id, { ok: false, error: error.message });
    }
  };

  const postGemSyncResult = async (id, result) => {
    try {
      await fetch(`${GEMSYNC_SERVER}/api/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...result }),
      });
    } catch {
      // Local sync server may be closed; Gemini should keep working normally.
    }
  };

  const executeGemSyncCommand = async (command) => {
    if (!command?.id) return;
    try {
      let result;
      if (command.type === "gemsync:sync-page") {
        result = await handleGemSyncPage(command.payload);
      } else if (command.type === "gemsync:bind-page") {
        result = await handleGemSyncBind(command.payload);
      } else {
        result = { ok: false, error: `Unknown command: ${command.type}` };
      }
      await postGemSyncResult(command.id, result);
    } catch (error) {
      await postGemSyncResult(command.id, { ok: false, error: error.message });
    }
  };

  let gemSyncPolling = false;
  const pollGemSyncServer = async () => {
    if (gemSyncPolling) return;
    gemSyncPolling = true;
    try {
      const conversationId = encodeURIComponent(getConversationId());
      const response = await fetch(`${GEMSYNC_SERVER}/api/command?conversationId=${conversationId}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data?.command) {
        await executeGemSyncCommand(data.command);
      }
    } catch {
      // The local PDF sync app is optional. Stay quiet when it is closed.
    } finally {
      gemSyncPolling = false;
    }
  };

  const refreshCurrentConversationState = async () => {
    const key = getConversationKey();
    currentKey = key;
    const saved = await readMarker(key);
    hasMarker = !!saved;
    ++restoreToken;
    ++markerScrollToken;
    ++deepTopToken;
    gemSyncLastReverseSignature = "";
    resetScrollingButtons();
    updateMarkButton();
    updateVisibility();
    setTimeout(restorePendingPdfDock, 300);
  };

  const saveMarker = async () => {
    const key = getConversationKey();
    if (!key) {
      showToast("Open a saved Gemini chat first.");
      return;
    }

    const scroller = getPrimaryScroller();
    const top = Math.max(0, scroller.scrollTop || currentScrollTop());
    const anchor = getVisibleAnchor();
    await storage.set(key, {
      top,
      anchor,
      href: location.href,
      title: document.title,
      savedAt: new Date().toISOString(),
    });
    currentKey = key;
    hasMarker = true;
    updateMarkButton();
    showToast("Reading position marked.");
  };

  const clearMarker = async () => {
    const key = getConversationKey();
    if (!key) return;
    await storage.remove(key);
    if (currentKey === key) {
      hasMarker = false;
      updateMarkButton();
    }
    showToast("Marker cleared.");
  };

  const resetScrollingButtons = () => {
    topButton.classList.remove("busy");
    setButtonContent(topButton, "top", "Top");
    restoreButton.classList.remove("busy");
    setButtonContent(restoreButton, "restore", "Restore");
    updateMarkButton();
    updateVisibility();
  };

  const cancelActiveScrolling = () => {
    ++deepTopToken;
    ++markerScrollToken;
    ++restoreToken;
    resetScrollingButtons();
    stopButton.blur();
    showToast("Stopped.");
  };

  let scheduled = false;
  const updateVisibility = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const busy = topButton.classList.contains("busy");
      topButton.classList.toggle("hidden", !busy && currentScrollTop() <= SHOW_TOP_AFTER);
      const scrollBusy = busy
        || restoreButton.classList.contains("busy");
      stopButton.classList.toggle("hidden", !scrollBusy);
    });
  };

  const detectRouteChange = () => {
    const key = getConversationKey();
    if (key !== currentKey) {
      refreshCurrentConversationState();
    }
  };

  const patchHistory = () => {
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name];
      history[name] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        setTimeout(detectRouteChange, 50);
        return result;
      };
    }
  };

  markButton.addEventListener("click", saveMarker);
  markButton.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    clearMarker();
  });
  pdfDockButton.addEventListener("click", togglePdfDock);
  restoreButton.addEventListener("click", () => scrollToMarker());
  topButton.addEventListener("click", () => scrollToDeepTop({ behavior: "smooth" }));
  stopButton.addEventListener("click", cancelActiveScrolling);
  const runtime = getChromeRuntime();
  try {
    if (runtime?.onMessage?.addListener) {
      runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === "gemsync:sync-page") {
          handleGemSyncPage(message.payload)
            .then((response) => sendResponse(response))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        }

        if (message?.type === "gemsync:bind-page") {
          handleGemSyncBind(message.payload)
            .then((response) => sendResponse(response))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        }

        return false;
      });
    }
  } catch (error) {
    if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
  }
  window.addEventListener("message", handleGemSyncFrameMessage);
  window.addEventListener("scroll", () => {
    updateVisibility();
    scheduleGeminiToPdfSync();
  }, true);
  window.addEventListener("resize", updateVisibility);
  window.addEventListener("popstate", () => setTimeout(detectRouteChange, 50));
  patchHistory();
  setInterval(() => {
    detectRouteChange();
    updateVisibility();
  }, 1000);
  setInterval(pollGemSyncServer, 650);
  setTimeout(pollGemSyncServer, 1200);
  refreshCurrentConversationState();
  setTimeout(restorePendingPdfDock, 900);
  setTimeout(restorePendingPdfDock, 2400);
})();
