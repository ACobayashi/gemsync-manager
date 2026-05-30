const $ = (id) => document.getElementById(id);

const elements = {
  workspace: $("workspace"),
  subjectId: $("subjectId"),
  subjectTitle: $("subjectTitle"),
  modelSelect: $("modelSelect"),
  proFallback: $("proFallback"),
  promptText: $("promptText"),
  status: $("status"),
  summaryCards: $("summaryCards"),
  details: $("details"),
  jobs: $("jobs"),
  log: $("log"),
  workflowHint: $("workflowHint"),
  stopJob: $("stopJob"),
  clearLog: $("clearLog"),
  refreshState: $("refreshState"),
  pickWorkspace: $("pickWorkspace"),
  scan: $("scan"),
  prepare: $("prepare"),
  chrome: $("chrome"),
  runGemini: $("runGemini"),
  resetProgress: $("resetProgress"),
  updatePlugin: $("updatePlugin"),
};

const state = {
  selectedJobId: null,
  pollTimer: 0,
  summary: null,
  formLoaded: false,
  lastAutoSubjectId: "",
  lastAutoSubjectTitle: "",
  chromeOk: false,
  jobs: [],
  refreshedJobIds: new Set(),
};

function setStatus(text) {
  elements.status.textContent = text;
}

function setWorkflowHint(text) {
  if (elements.workflowHint) elements.workflowHint.textContent = text;
}

function saveForm() {
  localStorage.setItem("gemsync-manager-form", JSON.stringify({
    workspace: elements.workspace.value,
    subjectId: elements.subjectId.value,
    subjectTitle: elements.subjectTitle.value,
    model: elements.modelSelect.value,
    proFallback: elements.proFallback.value,
    prompt: elements.promptText.value,
  }));
}

function loadForm(defaults) {
  const saved = JSON.parse(localStorage.getItem("gemsync-manager-form") || "{}");
  elements.workspace.value = saved.workspace || defaults.workspace || "";
  elements.subjectId.value = saved.subjectId || defaults.subjectId || "";
  elements.subjectTitle.value = saved.subjectTitle || defaults.subjectTitle || "";
  elements.modelSelect.value = saved.model || defaults.model || "pro";
  elements.proFallback.value = saved.proFallback || defaults.proFallback || "flash";
  elements.promptText.value = saved.prompt || defaults.prompt || "请详细讲解这一面PPT";
  state.lastAutoSubjectTitle = folderNameFromPath(elements.workspace.value);
  state.lastAutoSubjectId = subjectIdFromTitle(state.lastAutoSubjectTitle);
}

function stableHash(input) {
  let hash = 2166136261;
  for (const char of String(input || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function folderNameFromPath(input) {
  return String(input || "")
    .trim()
    .replace(/[\\/]+$/g, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "";
}

function subjectIdFromTitle(title) {
  const raw = String(title || "subject").trim();
  const ascii = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || `course-${stableHash(raw)}`;
}

function autoFillSubjectFromWorkspace(options = {}) {
  const title = folderNameFromPath(elements.workspace.value);
  if (!title) return;
  const id = subjectIdFromTitle(title);
  const force = !!options.force;
  const oldDefaultTitle = elements.subjectTitle.value === "算法导论";
  const oldDefaultId = elements.subjectId.value === "algorithms";
  const titleLooksAuto = !elements.subjectTitle.value.trim()
    || elements.subjectTitle.value === state.lastAutoSubjectTitle
    || oldDefaultTitle;
  const idLooksAuto = !elements.subjectId.value.trim()
    || elements.subjectId.value === state.lastAutoSubjectId
    || oldDefaultId;

  if (force || titleLooksAuto) elements.subjectTitle.value = title;
  if (force || idLooksAuto) elements.subjectId.value = id;

  state.lastAutoSubjectTitle = title;
  state.lastAutoSubjectId = id;
  saveForm();
}

function payload() {
  saveForm();
  return {
    workspace: elements.workspace.value.trim(),
    subjectId: elements.subjectId.value.trim(),
    title: elements.subjectTitle.value.trim(),
    model: elements.modelSelect.value,
    proFallback: elements.proFallback.value,
    prompt: elements.promptText.value.trim() || "请详细讲解这一面PPT",
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function card(label, value, meta = "", tone = "") {
  const toneClass = tone ? ` ${escapeHtml(tone)}` : "";
  return `<div class="card${toneClass}">
    <span class="card-label">${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    ${meta ? `<span class="card-meta">${escapeHtml(meta)}</span>` : ""}
  </div>`;
}

function renderSummary(summary) {
  state.summary = summary;
  const conversationCount = summary.progress.conversationCount || summary.conversationFoldersCount;
  const totalSlides = summary.progress.totalSlides || 0;
  const sentSlides = summary.progress.sentSlides || 0;
  elements.summaryCards.innerHTML = [
    card("PDF 文件", summary.pdfs.length, summary.pdfs.length ? "可以写入插件" : "还没扫到 PDF", summary.pdfs.length ? "tone-sky" : "tone-muted"),
    card("PPT 文件", summary.ppts.length, summary.ppts.length ? "可生成截图" : "可只用 PDF", summary.ppts.length ? "tone-amber" : "tone-muted"),
    card("截图 Deck", summary.decks.length, summary.decks.length ? `${totalSlides} 页截图` : "需要准备截图", summary.decks.length ? "tone-mint" : "tone-warn"),
    card("Gemini 对话", conversationCount, conversationCount ? "已记录链接" : "还没记录对话", conversationCount ? "tone-sky" : "tone-muted"),
    card("已问页数", totalSlides ? `${sentSlides}/${totalSlides}` : "0", totalSlides ? "按进度文件统计" : "暂无进度", totalSlides && sentSlides >= totalSlides ? "tone-mint" : "tone-muted"),
  ].join("");

  const deckRows = summary.decks.slice(0, 12).map((deck) => {
    return `<div class="detail-row">
      <div><strong>${escapeHtml(deck.title || deck.folder)}</strong><br><small>${escapeHtml(deck.folder)} · ${escapeHtml(deck.slides)} 页截图</small></div>
      <span class="badge deck-badge">${escapeHtml(deck.deckNumber ? `Deck ${deck.deckNumber}` : "Deck")}</span>
    </div>`;
  }).join("");

  const fileRows = summary.pdfs.slice(0, 8).map((file) => {
    return `<div class="detail-row">
      <div><strong>${escapeHtml(file.name)}</strong><br><small>${escapeHtml(file.path)}</small></div>
      <span class="badge">PDF</span>
    </div>`;
  }).join("");

  elements.details.innerHTML = deckRows || fileRows || "<p>还没有扫描到 PDF 或截图 deck。</p>";
  updateWorkflowState();
}

function renderJobs(jobs) {
  state.jobs = jobs;
  document.body.classList.toggle("has-running-job", jobs.some((job) => job.status === "running"));
  if (!jobs.length) {
    elements.jobs.innerHTML = "<p>还没有任务。</p>";
    updateWorkflowState();
    return;
  }

  elements.jobs.innerHTML = jobs.map((job) => {
    const active = job.id === state.selectedJobId ? " is-selected" : "";
    return `<button class="job${active}" data-job="${job.id}" type="button">
      <div><strong>${escapeHtml(job.title)}</strong><br><small>${escapeHtml(job.startedAt)}${job.finishedAt ? ` -> ${escapeHtml(job.finishedAt)}` : ""}</small></div>
      <span class="badge ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
    </button>`;
  }).join("");

  for (const button of elements.jobs.querySelectorAll("[data-job]")) {
    button.addEventListener("click", () => selectJob(button.dataset.job));
  }
  updateWorkflowState();
}

function clearSummary() {
  state.summary = null;
  elements.summaryCards.innerHTML = "";
  elements.details.innerHTML = "<p>请先扫描当前学科文件夹。</p>";
  updateWorkflowState();
}

function setStep(button, options = {}) {
  const enabled = !!options.enabled;
  const primary = !!options.primary;
  const complete = !!options.complete;
  const reason = options.reason || "";
  const step = button.closest(".step-item");
  let statePill = step?.querySelector(".step-state");
  if (step && !statePill) {
    statePill = document.createElement("span");
    statePill.className = "step-state";
    step.querySelector(".step-title")?.append(statePill);
  }

  button.disabled = !enabled;
  button.title = enabled ? "" : reason;
  button.classList.toggle("primary", primary && enabled);
  step?.classList.toggle("is-disabled", !enabled);
  step?.classList.toggle("is-next", primary && enabled);
  step?.classList.toggle("is-complete", complete);
  step?.classList.toggle("is-ready", enabled && !primary && !complete);
  step?.setAttribute("title", enabled ? "" : reason);
  if (statePill) {
    statePill.textContent = complete && enabled
      ? "可再打开"
      : complete
        ? "已完成"
        : primary && enabled
          ? "下一步"
          : enabled
            ? "可点击"
            : "未就绪";
  }
}

function updateWorkflowState() {
  const workspace = elements.workspace.value.trim();
  const summary = state.summary;
  const jobs = state.jobs || [];
  const running = jobs.some((job) => job.status === "running");
  const scanned = !!summary;
  const pdfCount = summary?.pdfs?.length || 0;
  const pptCount = summary?.ppts?.length || 0;
  const deckCount = summary?.decks?.length || 0;
  const conversationCount = summary?.progress?.conversationCount || summary?.conversationFoldersCount || 0;
  const completedDeckCount = summary?.progress?.completedDeckCount || 0;
  const allDecksComplete = deckCount > 0 && completedDeckCount >= deckCount;
  const hasAllConversations = deckCount > 0 && conversationCount >= deckCount;
  const hasFiles = pdfCount > 0 || pptCount > 0 || deckCount > 0;
  const hasScreenshots = deckCount > 0;
  const hasPpts = pptCount > 0;
  const chromeOk = !!state.chromeOk;

  let next = "scan";
  let hint = "先选择或确认学科文件夹，然后扫描。";

  if (!workspace) {
    hint = "先选择学科文件夹。";
  } else if (!scanned) {
    next = "scan";
    hint = "当前需要先扫描文件夹，确认里面有什么资料。";
  } else if (running) {
    next = "";
    hint = "当前有任务正在运行，先等它完成，或者在日志区停止任务。";
  } else if (!hasFiles) {
    next = "scan";
    hint = "这个文件夹里没有扫描到 PDF、PPT 或截图。请确认选的是课程文件夹。";
  } else if (!hasScreenshots && (hasPpts || pdfCount > 0)) {
    next = "prepare";
    hint = hasPpts
      ? "检测到 PPT，但还没有截图。下一步应该点“准备截图”。"
      : "当前只有 PDF，还没有截图。下一步应该点“准备截图”，把 PDF 每一页转成图片。";
  } else if (hasScreenshots && !chromeOk) {
    next = "chrome";
    hint = "已经有截图。下一步打开 Gemini 标签页，并确认 Gemini 已登录。";
  } else if (hasScreenshots && chromeOk && (allDecksComplete || hasAllConversations)) {
    next = "plugin";
    hint = allDecksComplete ? "这些截图看起来已经全部问完。下一步写入插件。" : "Gemini 对话数量已经对上。下一步写入插件。";
  } else if (hasScreenshots && chromeOk && conversationCount < deckCount) {
    next = "gemini";
    hint = "截图已准备好，Chrome 也已打开。下一步可以启动 Gemini 自动问。";
  } else {
    next = "chrome";
    hint = "截图已经准备好。下一步打开 Gemini 标签页。";
  }

  setStep(elements.scan, {
    enabled: !!workspace && !running,
    primary: next === "scan",
    complete: scanned,
    reason: workspace ? "当前有任务正在运行" : "请先选择学科文件夹",
  });
  setStep(elements.prepare, {
    enabled: scanned && !hasScreenshots && (hasPpts || pdfCount > 0) && !running,
    primary: next === "prepare",
    complete: hasScreenshots,
    reason: !scanned ? "请先扫描文件夹" : hasScreenshots ? "已经有截图" : (hasPpts || pdfCount > 0) ? "当前有任务正在运行" : "没有 PDF 或 PPT，无法生成截图",
  });
  setStep(elements.chrome, {
    enabled: scanned && hasScreenshots && !running,
    primary: next === "chrome",
    complete: chromeOk,
    reason: !scanned ? "请先扫描文件夹" : !hasScreenshots ? "没有截图，暂时不需要打开 Gemini 标签页" : "当前有任务正在运行",
  });
  setStep(elements.runGemini, {
    enabled: scanned && hasScreenshots && chromeOk && !allDecksComplete && !running,
    primary: next === "gemini",
    complete: allDecksComplete || hasAllConversations,
    reason: !scanned ? "请先扫描文件夹" : !hasScreenshots ? "没有截图，不能启动 Gemini 自动问" : !chromeOk ? "请先打开自动化 Chrome" : allDecksComplete ? "截图已经全部问完" : "当前有任务正在运行",
  });
  elements.resetProgress.disabled = !(scanned && hasScreenshots && !running);
  elements.resetProgress.title = !scanned
    ? "请先扫描文件夹"
    : !hasScreenshots
      ? "没有截图进度可以重置"
      : running
        ? "当前有任务正在运行"
        : "备份旧进度，并从第 1 页重新开始 Gemini 提问";
  setStep(elements.updatePlugin, {
    enabled: scanned && pdfCount > 0 && hasScreenshots && (allDecksComplete || hasAllConversations) && !running,
    primary: next === "plugin",
    complete: false,
    reason: !scanned ? "请先扫描文件夹" : !hasScreenshots ? "请先准备截图，最后再写入插件" : !(allDecksComplete || hasAllConversations) ? "请先启动 Gemini 自动问，最后再写入插件" : pdfCount > 0 ? "当前有任务正在运行" : "没有 PDF，无法写入插件",
  });
  setWorkflowHint(hint);
}

async function refreshState() {
  const data = await api("/api/state");
  state.chromeOk = !!data.chrome.ok;
  if (!state.formLoaded) {
    loadForm(data.defaults);
    state.formLoaded = true;
  }
  renderJobs(data.jobs);
  if (state.summary && elements.workspace.value.trim()) {
    await scan();
    return;
  }
  const chrome = data.chrome.ok ? `Chrome 自动化端口已打开：${data.chrome.browser}` : "Chrome 自动化端口未打开";
  setStatus(chrome);
  updateWorkflowState();
}

async function scan() {
  const data = await api("/api/scan", {
    method: "POST",
    body: JSON.stringify(payload()),
  });
  renderSummary(data.summary);
  setStatus("扫描完成");
  updateWorkflowState();
}

async function startJob(path, body = payload()) {
  const data = await api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  state.selectedJobId = data.job.id;
  renderJobs([data.job]);
  await refreshJobsAndLog();
  updateWorkflowState();
  return data.job;
}

async function selectJob(id) {
  state.selectedJobId = id;
  await refreshJobsAndLog();
}

async function refreshJobsAndLog() {
  const data = await api("/api/jobs");
  renderJobs(data.jobs);
  const justCompletedContentJob = data.jobs.find((job) => (
    (job.type === "prepare" || job.type === "gemini")
    && job.status === "complete"
    && !state.refreshedJobIds.has(job.id)
  ));
  if (justCompletedContentJob && state.summary) {
    state.refreshedJobIds.add(justCompletedContentJob.id);
    await scan();
  }
  if (state.selectedJobId && !data.jobs.some((job) => job.id === state.selectedJobId)) {
    state.selectedJobId = null;
  }
  if (!state.selectedJobId && data.jobs.length) state.selectedJobId = data.jobs[0].id;
  if (state.selectedJobId) {
    const logData = await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/log`);
    elements.log.textContent = logData.log || "暂无日志。";
    elements.stopJob.disabled = logData.job.status !== "running";
    elements.log.scrollTop = elements.log.scrollHeight;
  } else {
    elements.stopJob.disabled = true;
    elements.log.textContent = "还没有任务日志。";
  }
}

async function startChrome() {
  const data = await api("/api/chrome/start", {
    method: "POST",
    body: JSON.stringify(payload()),
  });
  if (data.result.openedTab) {
    setStatus("已在自动化 Chrome 中新开 Gemini 标签页");
  } else if (data.result.launched) {
    setStatus("已启动自动化 Chrome。第一次可能会开独立窗口，之后会复用新标签页。");
  } else {
    setStatus(data.result.alreadyRunning ? "自动化 Chrome 已经打开" : "已打开自动化 Chrome，请确认已登录 Gemini");
  }
  state.chromeOk = true;
  updateWorkflowState();
}

async function resetProgress() {
  const data = await api("/api/progress/reset", {
    method: "POST",
    body: JSON.stringify(payload()),
  });
  renderSummary(data.result.summary);
  setStatus(`已重置提问进度：${data.result.decks} 个 Deck 下次会从第 1 页开始`);
  await refreshJobsAndLog();
}

async function chooseFolder(input, title, options = {}) {
  setStatus("正在打开文件夹选择窗口...");
  const data = await api("/api/pick-folder", {
    method: "POST",
    body: JSON.stringify({
      title,
      initialPath: input.value.trim(),
    }),
  });

  if (data.canceled || !data.path) {
    setStatus("已取消选择文件夹");
    return;
  }

  input.value = data.path;
  if (input === elements.workspace) {
    autoFillSubjectFromWorkspace({ force: true });
    clearSummary();
  }
  saveForm();
  setStatus("已选择文件夹");
  if (options.scanAfterPick) await scan();
}

async function stopSelectedJob() {
  if (!state.selectedJobId) return;
  await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/stop`, { method: "POST" });
  await refreshJobsAndLog();
}

async function clearSelectedLog() {
  if (!state.selectedJobId) {
    elements.log.textContent = "暂无日志。";
    setStatus("日志显示已清空");
    return;
  }
  await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/log/clear`, { method: "POST" });
  elements.log.textContent = "暂无日志。";
  setStatus("当前任务日志已清空");
}

elements.workspace.addEventListener("change", () => {
  autoFillSubjectFromWorkspace();
  clearSummary();
});

for (const input of [
  elements.workspace,
  elements.subjectId,
  elements.subjectTitle,
  elements.modelSelect,
  elements.proFallback,
  elements.promptText,
]) {
  input.addEventListener("change", saveForm);
}
elements.promptText.addEventListener("input", saveForm);

elements.refreshState.addEventListener("click", () => refreshState().catch((error) => setStatus(error.message)));
elements.pickWorkspace.addEventListener("click", () => chooseFolder(elements.workspace, "选择学科文件夹", { scanAfterPick: true }).catch((error) => setStatus(error.message)));
elements.scan.addEventListener("click", () => scan().catch((error) => setStatus(error.message)));
elements.prepare.addEventListener("click", () => startJob("/api/jobs/prepare").catch((error) => setStatus(error.message)));
elements.chrome.addEventListener("click", () => startChrome().catch((error) => setStatus(error.message)));
elements.runGemini.addEventListener("click", () => startJob("/api/jobs/gemini").catch((error) => setStatus(error.message)));
elements.resetProgress.addEventListener("click", () => resetProgress().catch((error) => setStatus(error.message)));
elements.updatePlugin.addEventListener("click", () => startJob("/api/jobs/plugin").catch((error) => setStatus(error.message)));
elements.stopJob.addEventListener("click", () => stopSelectedJob().catch((error) => setStatus(error.message)));
elements.clearLog.addEventListener("click", () => clearSelectedLog().catch((error) => setStatus(error.message)));

state.pollTimer = setInterval(() => {
  refreshJobsAndLog().catch(() => {});
}, 1800);

refreshState().catch((error) => setStatus(error.message));
updateWorkflowState();
