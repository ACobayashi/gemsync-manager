import * as pdfjsLib from "./pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.mjs", import.meta.url).toString();

const $ = (id) => document.getElementById(id);

const elements = {
  deckTitle: $("deckTitle"),
  subjectSelect: $("subjectSelect"),
  deckSelect: $("deckSelect"),
  prevPage: $("prevPage"),
  nextPage: $("nextPage"),
  pageInput: $("pageInput"),
  totalPages: $("totalPages"),
  autoSync: $("autoSync"),
  syncPage: $("syncPage"),
  deepSyncPage: $("deepSyncPage"),
  bindPage: $("bindPage"),
  openGemini: $("openGemini"),
  status: $("status"),
  pageRail: $("pageRail"),
  viewer: $("viewer"),
  pages: $("pages"),
};

const state = {
  subjects: [],
  subject: null,
  config: null,
  configUrl: "",
  deck: null,
  pdf: null,
  pageCount: 0,
  currentPage: 1,
  scale: 1,
  embedded: false,
  rendered: new Set(),
  rendering: new Map(),
  observer: null,
  syncTimer: 0,
  bridgeSeq: 0,
  bridgeWaiters: new Map(),
  parentSeq: 0,
  parentWaiters: new Map(),
  lastSent: "",
  syncBusy: false,
  queuedAutoPage: null,
  visiblePageRaf: 0,
  estimatedFrameHeight: 0,
  deckSwitchSeq: 0,
  suppressAutoSyncUntil: 0,
};

const bridgeEvents = {
  sync: "gemsync:sync-page",
  bind: "gemsync:bind-page",
  open: "gemsync:open-gemini",
};

function setStatus(text, tone = "neutral") {
  elements.status.textContent = text;
  elements.status.className = `status ${tone}`;
}

function notifyParentState() {
  if (!state.embedded) return;
  window.parent.postMessage({
    source: "gemsync-app-iframe",
    type: "gemsync:pdf-state",
    payload: {
      deckId: state.deck?.id || "",
      deckTitle: state.deck?.title || "",
      subjectId: state.subject?.id || "",
      subjectTitle: state.subject?.title || "",
      conversationId: state.deck?.conversationId || "",
      geminiUrl: state.deck?.geminiUrl || "",
      pageNumber: state.currentPage || 1,
      pagePrompt: state.config?.pagePrompt || "",
      autoSyncEnabled: !!elements.autoSync.checked,
    },
  }, "*");
}

function clampPage(page) {
  return Math.max(1, Math.min(state.pageCount || 1, Number(page) || 1));
}

function getSubjectId() {
  return state.subject?.id || "default";
}

function getStorageKey(deckId, pageNumber) {
  return `gemsync:${getSubjectId()}:${deckId}:page:${pageNumber}`;
}

function getLegacyStorageKey(deckId, pageNumber) {
  return `gemsync:${deckId}:page:${pageNumber}`;
}

function getExactBinding(pageNumber = state.currentPage) {
  const raw = localStorage.getItem(getStorageKey(state.deck.id, pageNumber))
    || localStorage.getItem(getLegacyStorageKey(state.deck.id, pageNumber));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getBindingForPage(pageNumber = state.currentPage) {
  const exact = getExactBinding(pageNumber);
  if (exact) {
    return {
      ...exact,
      basePageNumber: pageNumber,
      pageOffset: 0,
      targetPromptIndex: exact.promptIndex || null,
      targetImagePromptIndex: exact.imagePromptIndex || null,
    };
  }

  let best = null;
  const prefixes = [
    `gemsync:${getSubjectId()}:${state.deck.id}:page:`,
    `gemsync:${state.deck.id}:page:`,
  ];
  for (const prefix of prefixes) {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const basePageNumber = Number(key.slice(prefix.length));
      if (!basePageNumber || basePageNumber > pageNumber) continue;
      const binding = getExactBinding(basePageNumber);
      if (!binding) continue;
      if (!best || basePageNumber > best.basePageNumber) {
        best = { ...binding, basePageNumber };
      }
    }
  }

  if (!best) return null;
  const pageOffset = pageNumber - best.basePageNumber;
  return {
    ...best,
    pageOffset,
    targetPromptIndex: best.promptIndex ? best.promptIndex + pageOffset : null,
    targetImagePromptIndex: best.imagePromptIndex ? best.imagePromptIndex + pageOffset : null,
  };
}

function setLocalBinding(pageNumber, binding) {
  localStorage.setItem(getStorageKey(state.deck.id, pageNumber), JSON.stringify(binding));
}

function setAutoSyncEnabled(enabled, statusText = "") {
  elements.autoSync.checked = enabled;
  localStorage.setItem("gemsync:autoSync", enabled ? "true" : "false");
  if (!enabled) {
    clearTimeout(state.syncTimer);
  }
  if (statusText) {
    setStatus(statusText, enabled ? "ok" : "warn");
  }
  notifyParentState();
}

function updateControls() {
  elements.deckTitle.textContent = state.deck?.title || "算法导论";
  elements.pageInput.value = state.currentPage;
  elements.pageInput.max = state.pageCount || 1;
  elements.totalPages.textContent = state.pageCount || 0;
  elements.prevPage.disabled = state.currentPage <= 1;
  elements.nextPage.disabled = state.currentPage >= state.pageCount;

  for (const button of elements.pageRail.querySelectorAll(".rail-page")) {
    const page = Number(button.dataset.page);
    const isActive = page === state.currentPage;
    button.classList.toggle("active", isActive);
    if (isActive) {
      button.scrollIntoView({ block: "nearest" });
    }
    button.title = getExactBinding(page) ? `第 ${page} 页：已有校准` : `第 ${page} 页`;
  }
  notifyParentState();
}

function postToExtension(kind, payload, timeoutMs = 7000) {
  const id = ++state.bridgeSeq;
  const eventType = bridgeEvents[kind];
  if (!eventType) {
    return Promise.reject(new Error(`Unknown bridge event: ${kind}`));
  }

  const message = {
    source: "gemsync-app",
    id,
    type: eventType,
    payload,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.bridgeWaiters.delete(id);
      reject(new Error("没有收到 Chrome 插件回应，请确认 Gemini Reading Marker 插件已重新加载。"));
    }, timeoutMs);

    state.bridgeWaiters.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });

    window.postMessage(message, window.location.origin);
  });
}

async function postCommand(kind, payload) {
  const type = bridgeEvents[kind];
  if (!type) throw new Error(`Unknown command kind: ${kind}`);
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `发送同步任务失败：${response.status}`);
  }
  return data.id;
}

async function waitForCommandResult(id, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`/api/result/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `读取同步结果失败：${response.status}`);
    }
    if (!data.pending) {
      const result = data.result || {};
      if (!result.ok) {
        throw new Error(result.error || "Gemini 执行同步失败。");
      }
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  throw new Error("已发送同步任务，但 Gemini 还没回报执行结果。请刷新 Gemini 页或重新加载扩展。");
}

window.addEventListener("message", (event) => {
  if (event.source === window && event.origin === window.location.origin) {
    const data = event.data;
    if (data?.source !== "gemsync-extension" || !data.id) return;

    const waiter = state.bridgeWaiters.get(data.id);
    if (!waiter) return;
    state.bridgeWaiters.delete(data.id);

    if (data.ok) {
      waiter.resolve(data);
    } else {
      waiter.reject(new Error(data.error || "插件执行失败。"));
    }
    return;
  }

  const data = event.data;
  if (data?.source !== "gemsync-parent") return;
  if (data.type === "gemsync:gemini-visible-page") {
    handleGeminiVisiblePage(data.payload).catch((error) => {
      console.error(error);
      setStatus(error.message, "warn");
    });
    return;
  }
  if (!data.id) return;

  const waiter = state.parentWaiters.get(data.id);
  if (!waiter) return;
  state.parentWaiters.delete(data.id);

  if (data.ok) {
    waiter.resolve(data);
  } else {
    waiter.reject(new Error(data.error || "插件执行失败。"));
  }
});

function postToParent(kind, payload, timeoutMs = 90000, options = {}) {
  const id = ++state.parentSeq;
  const eventType = bridgeEvents[kind];
  if (!eventType) {
    return Promise.reject(new Error(`Unknown parent event: ${kind}`));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.parentWaiters.delete(id);
      if (options.resolveOnTimeout) {
        resolve({ ok: true, pending: true });
        return;
      }
      reject(new Error("左侧 Gemini 没有回应。请刷新 Gemini 页面；如果刚更新过扩展，也要在 chrome://extensions 里重新加载扩展。"));
    }, timeoutMs);

    state.parentWaiters.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });

    window.parent.postMessage({
      source: "gemsync-app-iframe",
      id,
      type: eventType,
      payload,
    }, "*");
  });
}

function syncPayload(pageNumber = state.currentPage, reason = "manual", options = {}) {
  const binding = getBindingForPage(pageNumber);
  return {
    subjectId: state.subject?.id || "",
    subjectTitle: state.subject?.title || "",
    deckId: state.deck.id,
    deckTitle: state.deck.title,
    conversationId: state.deck.conversationId,
    geminiUrl: state.deck.geminiUrl,
    pagePrompt: state.config.pagePrompt,
    pageNumber,
    totalPages: state.pageCount,
    reason,
    deep: !!options.deep,
    binding,
  };
}

function bindingEntriesForCurrentDeck() {
  if (!state.deck?.id) return [];
  const prefixes = [
    `gemsync:${getSubjectId()}:${state.deck.id}:page:`,
    `gemsync:${state.deck.id}:page:`,
  ];
  const entries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const prefix = prefixes.find((item) => key?.startsWith(item));
    if (!prefix) continue;
    const pageNumber = Number(key.slice(prefix.length));
    if (!pageNumber) continue;
    try {
      const binding = JSON.parse(localStorage.getItem(key) || "{}");
      entries.push({ ...binding, pageNumber });
    } catch {
      // Ignore bad calibration records; the fallback index still works.
    }
  }
  return entries;
}

function pageFromCalibratedIndex(kind, index) {
  const value = Number(index) || 0;
  if (!value) return null;

  const best = bindingEntriesForCurrentDeck()
    .filter((entry) => Number(entry[kind]) > 0 && Number(entry[kind]) <= value)
    .sort((a, b) => Number(b[kind]) - Number(a[kind]) || b.pageNumber - a.pageNumber)[0];

  if (!best) return null;
  return best.pageNumber + value - Number(best[kind]);
}

function resolvePageFromGeminiPosition(payload = {}) {
  const imageIndex = Number(payload.imagePromptIndex) || 0;
  const promptIndex = Number(payload.promptIndex) || 0;
  const calibratedImagePage = pageFromCalibratedIndex("imagePromptIndex", imageIndex);
  const calibratedPromptPage = pageFromCalibratedIndex("promptIndex", promptIndex);
  return clampPage(calibratedImagePage || calibratedPromptPage || imageIndex || promptIndex || state.currentPage);
}

function enableGeminiFollowAfterPositioning(pageNumber, actionText = "已同步") {
  if (!elements.autoSync.checked) {
    setAutoSyncEnabled(true);
  } else {
    notifyParentState();
  }
  setStatus(`${actionText}第 ${pageNumber} 页；现在滚动 Gemini 会同步 PDF`, "ok");
}

async function sendSync(reason = "manual", options = {}) {
  if (!state.deck) return;
  const pageNumber = state.currentPage;
  const deep = !!options.deep;

  if (state.syncBusy) {
    if (reason === "auto") {
      state.queuedAutoPage = pageNumber;
      setStatus(`同步中，已记住第 ${pageNumber} 页`, "busy");
      return;
    }
    setStatus("正在同步，先等这次结束", "busy");
    return;
  }

  const signature = `${state.deck.id}:${pageNumber}:${reason}:${deep ? "deep" : "quick"}`;
  if (reason === "auto" && state.lastSent === signature) return;
  state.lastSent = signature;

  setStatus(deep ? `深度同步第 ${pageNumber} 页` : `同步第 ${pageNumber} 页`, "busy");
  state.syncBusy = true;
  try {
    const payload = syncPayload(pageNumber, reason, { deep });
    const result = state.embedded
      ? await postToParent("sync", payload, deep ? 310000 : 2000, { resolveOnTimeout: !deep })
      : await waitForCommandResult(await postCommand("sync", payload), deep ? 310000 : 12000);
    if (result.pending) {
      if (reason !== "auto") {
        enableGeminiFollowAfterPositioning(pageNumber, "已发送同步");
      } else {
        setStatus(`已发送同步第 ${pageNumber} 页`, "ok");
      }
      return;
    }
    if (result.usedBinding) {
      if (reason !== "auto") {
        enableGeminiFollowAfterPositioning(pageNumber, "已到校准位置");
      } else {
        setStatus(`已到校准位置：第 ${pageNumber} 页`, "ok");
      }
    } else {
      if (reason !== "auto" && (result.promptIndex || result.imagePromptIndex)) {
        setLocalBinding(pageNumber, {
          promptIndex: result.promptIndex || null,
          imagePromptIndex: result.imagePromptIndex || null,
          promptCount: result.foundPrompts || null,
          imagePromptCount: result.foundImagePrompts || null,
          autoLearned: true,
          savedAt: new Date().toISOString(),
        });
        updateControls();
      }
      if (reason !== "auto") {
        enableGeminiFollowAfterPositioning(pageNumber, "已同步");
      } else {
        setStatus(`已同步第 ${pageNumber} 页`, "ok");
      }
    }
  } catch (error) {
    if (reason === "auto") {
      setAutoSyncEnabled(false, "自动同步已暂停，不影响翻 PDF。");
    } else {
      setStatus(error.message, "warn");
    }
  } finally {
    state.syncBusy = false;
    if (state.queuedAutoPage && state.queuedAutoPage !== pageNumber) {
      const queuedPage = state.queuedAutoPage;
      state.queuedAutoPage = null;
      if (elements.autoSync.checked) {
        goToPage(queuedPage, "auto");
        setTimeout(() => sendSync("auto"), 150);
      }
    } else {
      state.queuedAutoPage = null;
    }
  }
}

function scheduleAutoSync() {
  if (!elements.autoSync.checked) return;
  if (Date.now() < state.suppressAutoSyncUntil) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => {
    sendSync("auto");
  }, 900);
}

async function handleGeminiVisiblePage(payload = {}) {
  if (!state.embedded || !elements.autoSync.checked || !state.config) return;
  const deckId = payload.deckId || state.deck?.id;
  const page = resolvePageFromGeminiPosition(payload);
  if (!page) return;

  state.suppressAutoSyncUntil = Date.now() + 1600;
  clearTimeout(state.syncTimer);

  if (deckId && deckId !== state.deck?.id) {
    await loadDeck(deckId, page, { fromGemini: true });
    setStatus(`Gemini -> PDF 第 ${page} 页`, "ok");
    return;
  }

  if (page !== state.currentPage) {
    goToPage(page, "auto", { fromGemini: true });
    setStatus(`Gemini -> PDF 第 ${page} 页`, "ok");
  }
}

async function bindCurrentPage() {
  if (!state.deck) return;
  const pageNumber = state.currentPage;
  setStatus(`校准第 ${pageNumber} 页`, "busy");
  try {
    const result = state.embedded
      ? await postToParent("bind", syncPayload(pageNumber, "bind"), 30000)
      : await waitForCommandResult(await postCommand("bind", syncPayload(pageNumber, "bind")), 15000);
    const binding = {
      ...result.binding,
      deckId: state.deck.id,
      conversationId: state.deck.conversationId,
      pageNumber,
      savedAt: new Date().toISOString(),
    };
    setLocalBinding(pageNumber, binding);
    updateControls();
    enableGeminiFollowAfterPositioning(pageNumber, "已校准");
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

async function openGemini() {
  if (!state.deck) return;
  await switchGeminiForDeck(state.currentPage, "open");
}

async function switchGeminiForDeck(pageNumber = 1, reason = "deck-change") {
  if (!state.deck?.geminiUrl) return;
  const page = Math.max(1, Number(pageNumber) || 1);
  const payload = syncPayload(page, reason);

  if (state.embedded) {
    await postToParent("open", payload, 7000);
    setStatus("Gemini chat switched", "ok");
    return;
  }

  window.open(state.deck.geminiUrl, "gemsync-gemini");
  setStatus("Gemini chat opened", "ok");
}

function buildRail() {
  const fragment = document.createDocumentFragment();
  for (let page = 1; page <= state.pageCount; page += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rail-page";
    button.dataset.page = String(page);
    button.textContent = String(page);
    button.addEventListener("click", () => goToPage(page));
    fragment.append(button);
  }
  elements.pageRail.replaceChildren(fragment);
}

function buildPageShells() {
  const fragment = document.createDocumentFragment();
  const estimatedFrameHeight = state.estimatedFrameHeight || 360;
  for (let page = 1; page <= state.pageCount; page += 1) {
    const shell = document.createElement("section");
    shell.className = "page-shell";
    shell.id = `page-${page}`;
    shell.dataset.page = String(page);
    shell.style.minHeight = `${estimatedFrameHeight + 32}px`;

    const label = document.createElement("div");
    label.className = "page-label";
    label.textContent = `第 ${page} 页`;

    const frame = document.createElement("div");
    frame.className = "page-frame";
    frame.dataset.page = String(page);
    frame.style.minHeight = `${estimatedFrameHeight}px`;

    const skeleton = document.createElement("div");
    skeleton.className = "skeleton";
    frame.append(skeleton);

    shell.append(label, frame);
    fragment.append(shell);
  }
  elements.pages.replaceChildren(fragment);
}

async function estimatePageHeight() {
  try {
    const page = await state.pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = computeScale(baseViewport);
    const viewport = page.getViewport({ scale });
    state.estimatedFrameHeight = Math.max(320, Math.floor(viewport.height));
  } catch {
    state.estimatedFrameHeight = 360;
  }
}

function getVisiblePage() {
  let best = null;
  const rootRect = elements.viewer.getBoundingClientRect();
  const rootTop = rootRect.top;
  const rootBottom = rootRect.bottom;
  const rootHeight = rootRect.height || elements.viewer.clientHeight;
  const anchor = rootTop + Math.min(140, rootHeight * 0.18);

  for (const shell of elements.pages.querySelectorAll(".page-shell")) {
    const rect = shell.getBoundingClientRect();
    const visibleHeight = Math.min(rect.bottom, rootBottom) - Math.max(rect.top, rootTop);
    if (visibleHeight <= 0) continue;
    const containsAnchor = rect.top <= anchor && rect.bottom >= anchor;
    const distance = Math.abs(rect.top - rootTop);
    const score = containsAnchor
      ? 100000 - distance
      : (visibleHeight / Math.max(1, rect.height)) * 1000 - Math.abs(rect.top - anchor);
    if (!best || score > best.score) {
      best = { page: Number(shell.dataset.page), score };
    }
  }
  return best?.page || null;
}

function syncCurrentPageFromViewport() {
  const page = getVisiblePage();
  if (!page || page === state.currentPage) return;
  state.currentPage = page;
  updateControls();
  renderAround(page);
  scheduleAutoSync();
}

function requestVisiblePageUpdate() {
  if (state.visiblePageRaf) return;
  state.visiblePageRaf = requestAnimationFrame(() => {
    state.visiblePageRaf = 0;
    syncCurrentPageFromViewport();
  });
}

function installObserver() {
  state.observer?.disconnect();
  state.observer = new IntersectionObserver(() => {
    requestVisiblePageUpdate();
  }, {
    root: elements.viewer,
    threshold: [0.08, 0.18, 0.32, 0.48, 0.62, 0.78],
  });

  for (const shell of elements.pages.querySelectorAll(".page-shell")) {
    state.observer.observe(shell);
  }
}

function computeScale(viewport) {
  const maxWidth = Math.min(1080, Math.max(360, elements.viewer.clientWidth - 60));
  return Math.max(0.45, Math.min(2.2, maxWidth / viewport.width));
}

async function renderPage(pageNumber) {
  if (!state.pdf || state.rendered.has(pageNumber)) return;
  if (state.rendering.has(pageNumber)) return state.rendering.get(pageNumber);

  const task = (async () => {
    try {
      const page = await state.pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = computeScale(baseViewport);
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const context = canvas.getContext("2d", { alpha: false });
      await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
      }).promise;

      const frame = elements.pages.querySelector(`.page-frame[data-page="${pageNumber}"]`);
      if (frame) {
        frame.style.minHeight = `${Math.floor(viewport.height)}px`;
        frame.replaceChildren(canvas);
      }
      state.rendered.add(pageNumber);
    } catch (error) {
      const frame = elements.pages.querySelector(`.page-frame[data-page="${pageNumber}"]`);
      if (frame) {
        frame.textContent = `第 ${pageNumber} 页加载失败：${error.message}`;
      }
    } finally {
      state.rendering.delete(pageNumber);
    }
  })();

  state.rendering.set(pageNumber, task);
  return task;
}

function renderAround(pageNumber) {
  const targets = [];
  for (let page = pageNumber - 2; page <= pageNumber + 2; page += 1) {
    if (page >= 1 && page <= state.pageCount) targets.push(page);
  }
  for (const page of targets) {
    renderPage(page);
  }
}

function scrollViewerToShell(shell) {
  const targetTop = shell.offsetTop - elements.pages.offsetTop;
  elements.viewer.scrollTop = Math.max(0, targetTop - 2);
}

function scrollViewerToPage(page) {
  if (state.currentPage !== page) return;
  const shell = elements.pages.querySelector(`#page-${page}`);
  if (shell) scrollViewerToShell(shell);
}

function goToPage(pageNumber, behavior = "smooth", options = {}) {
  const page = clampPage(pageNumber);
  const shell = elements.pages.querySelector(`#page-${page}`);
  if (!shell) return;
  if (options.fromGemini) {
    state.suppressAutoSyncUntil = Date.now() + 1600;
    clearTimeout(state.syncTimer);
  }
  state.currentPage = page;
  updateControls();
  scrollViewerToShell(shell);
  requestAnimationFrame(() => scrollViewerToPage(page));
  setTimeout(() => scrollViewerToPage(page), 80);
  setTimeout(() => scrollViewerToPage(page), 250);
  renderAround(page);
  renderPage(page).then(() => {
    scrollViewerToPage(page);
  });
  if (!options.fromGemini) {
    scheduleAutoSync();
  }
}

function normalizeSubjectConfig(config, configUrl) {
  const baseUrl = new URL(configUrl, location.href);
  const decks = (config.decks || []).map((deck) => ({
    ...deck,
    pdfUrl: new URL(deck.pdfUrl, baseUrl).toString(),
  }));
  return { ...config, decks };
}

async function loadSubject(subjectId, options = {}) {
  const subject = state.subjects.find((item) => item.id === subjectId) || state.subjects[0];
  if (!subject) throw new Error("没有可用学科配置");

  state.subject = subject;
  elements.subjectSelect.value = subject.id;
  elements.deckSelect.replaceChildren();

  const configUrl = new URL(subject.configUrl, location.href).toString();
  setStatus("读取学科配置", "busy");
  const response = await fetch(configUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`配置读取失败：${response.status}`);

  state.configUrl = configUrl;
  state.config = normalizeSubjectConfig(await response.json(), configUrl);

  for (const deck of state.config.decks) {
    const option = document.createElement("option");
    option.value = deck.id;
    option.textContent = deck.title;
    elements.deckSelect.append(option);
  }

  const deckId = options.deckId || state.config.decks[0]?.id;
  await loadDeck(deckId, options.initialPage || 1, options);
}

async function loadDeck(deckId, initialPage = 1, options = {}) {
  const runId = ++state.deckSwitchSeq;
  const deck = state.config.decks.find((item) => item.id === deckId) || state.config.decks[0];
  state.deck = deck;
  state.pdf = null;
  state.rendered.clear();
  state.rendering.clear();
  state.lastSent = "";
  state.currentPage = 1;
  state.pageCount = deck.totalPages || 0;
  state.observer?.disconnect();
  elements.viewer.scrollTop = 0;
  elements.pages.replaceChildren();
  elements.pageRail.replaceChildren();
  elements.subjectSelect.value = state.subject?.id || "";
  elements.deckSelect.value = deck.id;
  history.replaceState(null, "", `#subject=${encodeURIComponent(state.subject?.id || "")}&deck=${encodeURIComponent(deck.id)}&page=${Math.max(1, Number(initialPage) || 1)}${state.embedded ? "&embed=1" : ""}`);

  setStatus("加载 PDF", "busy");
  const loadingTask = pdfjsLib.getDocument({
    url: new URL(deck.pdfUrl, location.href).toString(),
    cMapUrl: new URL("./pdfjs/cmaps/", location.href).toString(),
    cMapPacked: true,
    standardFontDataUrl: new URL("./pdfjs/standard_fonts/", location.href).toString(),
  });
  state.pdf = await loadingTask.promise;
  state.pageCount = state.pdf.numPages;
  await estimatePageHeight();

  buildRail();
  buildPageShells();
  installObserver();
  updateControls();
  renderAround(clampPage(initialPage));
  goToPage(clampPage(initialPage), "auto", { fromGemini: !!options.fromGemini });
  if (options.switchGemini && runId === state.deckSwitchSeq) {
    try {
      await switchGeminiForDeck(clampPage(initialPage), "deck-change");
      return;
    } catch (error) {
      setStatus(error.message, "warn");
      return;
    }
  }
  setStatus("就绪", "ok");
}

async function init() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  state.embedded = window.parent !== window || hash.get("embed") === "1";
  document.body.classList.toggle("embedded", state.embedded);

  setStatus("读取配置", "busy");
  const response = await fetch("./config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`配置读取失败：${response.status}`);
  state.config = await response.json();

  for (const deck of state.config.decks) {
    const option = document.createElement("option");
    option.value = deck.id;
    option.textContent = deck.title;
    elements.deckSelect.append(option);
  }

  elements.deckSelect.addEventListener("change", () => {
    loadDeck(elements.deckSelect.value, 1, { switchGemini: true }).catch((error) => {
      console.error(error);
      setStatus(error.message, "warn");
    });
  });
  elements.prevPage.addEventListener("click", () => goToPage(state.currentPage - 1));
  elements.nextPage.addEventListener("click", () => goToPage(state.currentPage + 1));
  elements.pageInput.addEventListener("change", () => goToPage(elements.pageInput.value));
  elements.pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      goToPage(elements.pageInput.value);
    }
  });
  elements.syncPage.addEventListener("click", () => sendSync("manual"));
  elements.deepSyncPage.addEventListener("click", () => sendSync("manual", { deep: true }));
  elements.bindPage.addEventListener("click", bindCurrentPage);
  elements.openGemini.addEventListener("click", openGemini);
  elements.autoSync.checked = localStorage.getItem("gemsync:autoSync") === "true";
  elements.autoSync.addEventListener("change", () => {
    if (elements.autoSync.checked) {
      setAutoSyncEnabled(true);
      scheduleAutoSync();
    } else {
      setAutoSyncEnabled(false, "自动同步已关闭");
    }
  });
  elements.viewer.addEventListener("scroll", () => {
    renderAround(state.currentPage);
    requestVisiblePageUpdate();
  }, { passive: true });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      state.rendered.clear();
      for (const frame of elements.pages.querySelectorAll(".page-frame")) {
        const page = Number(frame.dataset.page);
        if (Math.abs(page - state.currentPage) <= 2) {
          frame.replaceChildren(Object.assign(document.createElement("div"), { className: "skeleton" }));
        }
      }
      renderAround(state.currentPage);
    }, 180);
  });

  const deckId = hash.get("deck") || state.config.decks[0]?.id;
  const page = Number(hash.get("page") || 1);
  elements.deckSelect.value = deckId;
  await loadDeck(deckId, page);
}

async function initSubjects() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  state.embedded = window.parent !== window || hash.get("embed") === "1";
  document.body.classList.toggle("embedded", state.embedded);

  setStatus("读取学科列表", "busy");
  const response = await fetch("./subjects.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`学科列表读取失败：${response.status}`);
  const subjectsConfig = await response.json();
  state.subjects = uniqueSubjects(subjectsConfig.subjects || []);

  for (const subject of state.subjects) {
    const option = document.createElement("option");
    option.value = subject.id;
    option.textContent = subject.title;
    elements.subjectSelect.append(option);
  }

  elements.subjectSelect.addEventListener("change", () => {
    loadSubject(elements.subjectSelect.value, { initialPage: 1, switchGemini: true }).catch((error) => {
      console.error(error);
      setStatus(error.message, "warn");
    });
  });

  elements.deckSelect.addEventListener("change", () => {
    loadDeck(elements.deckSelect.value, 1, { switchGemini: true }).catch((error) => {
      console.error(error);
      setStatus(error.message, "warn");
    });
  });
  elements.prevPage.addEventListener("click", () => goToPage(state.currentPage - 1));
  elements.nextPage.addEventListener("click", () => goToPage(state.currentPage + 1));
  elements.pageInput.addEventListener("change", () => goToPage(elements.pageInput.value));
  elements.pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      goToPage(elements.pageInput.value);
    }
  });
  elements.syncPage.addEventListener("click", () => sendSync("manual"));
  elements.deepSyncPage.addEventListener("click", () => sendSync("manual", { deep: true }));
  elements.bindPage.addEventListener("click", bindCurrentPage);
  elements.openGemini.addEventListener("click", openGemini);
  elements.autoSync.checked = localStorage.getItem("gemsync:autoSync") === "true";
  elements.autoSync.addEventListener("change", () => {
    if (elements.autoSync.checked) {
      setAutoSyncEnabled(true);
      scheduleAutoSync();
    } else {
      setAutoSyncEnabled(false, "自动同步已关闭");
    }
  });
  elements.viewer.addEventListener("scroll", () => {
    renderAround(state.currentPage);
    requestVisiblePageUpdate();
  }, { passive: true });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      state.rendered.clear();
      for (const frame of elements.pages.querySelectorAll(".page-frame")) {
        const page = Number(frame.dataset.page);
        if (Math.abs(page - state.currentPage) <= 2) {
          frame.replaceChildren(Object.assign(document.createElement("div"), { className: "skeleton" }));
        }
      }
      renderAround(state.currentPage);
    }, 180);
  });

  const subjectId = hash.get("subject") || subjectsConfig.defaultSubject || state.subjects[0]?.id;
  const deckId = hash.get("deck") || "";
  const page = Number(hash.get("page") || 1);
  await loadSubject(subjectId, { deckId, initialPage: page });
}

function subjectTitleKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function uniqueSubjects(subjects) {
  const result = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  for (const subject of subjects) {
    const titleKey = subjectTitleKey(subject.title);
    if ((subject.id && seenIds.has(subject.id)) || (titleKey && seenTitles.has(titleKey))) continue;
    result.push(subject);
    if (subject.id) seenIds.add(subject.id);
    if (titleKey) seenTitles.add(titleKey);
  }
  return result;
}

initSubjects().catch((error) => {
  console.error(error);
  setStatus(error.message, "warn");
});
