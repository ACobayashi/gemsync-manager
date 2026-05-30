import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const APP_ROOT = path.join(ROOT, "app");
const PORT = Number(process.env.GEMSYNC_MANAGER_PORT || 5188);
const HOST = "127.0.0.1";

const NODE = process.env.GEMSYNC_NODE || process.execPath || "node";
const PYTHON = process.env.GEMSYNC_PYTHON || "python";
const PDFINFO = process.env.GEMSYNC_PDFINFO || "pdfinfo";
const PDFTOPPM = process.env.GEMSYNC_PDFTOPPM || "pdftoppm";
const CHROME = process.env.GEMSYNC_CHROME || firstExisting([
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
]) || "chrome.exe";
const AUTOMATION_SCRIPTS_ROOT = process.env.GEMSYNC_AUTOMATION_SCRIPTS || path.join(ROOT, "scripts");
const LEGACY_SKILL_ROOT = process.env.GEMSYNC_SKILL_ROOT || "";
const DEFAULT_EXTENSION_ROOT = path.join(ROOT, "extension");
const DEFAULT_WORKSPACE = process.env.GEMSYNC_DEFAULT_WORKSPACE || "";
const DEFAULT_SUBJECT_ID = process.env.GEMSYNC_DEFAULT_SUBJECT_ID || "";
const DEFAULT_SUBJECT_TITLE = process.env.GEMSYNC_DEFAULT_SUBJECT_TITLE || "";
const DEFAULT_PROMPT = process.env.GEMSYNC_DEFAULT_PROMPT || "请详细讲解这一面PPT";
const DEFAULT_GEMINI_MODEL = "pro";
const DEFAULT_PRO_FALLBACK = "flash";
const CHROME_DEBUG_URL = "http://127.0.0.1:9222";
const GEMINI_URL = "https://gemini.google.com/app";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const jobs = new Map();
let jobSeq = 0;

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: "Not found" });
}

function badRequest(res, error) {
  sendJson(res, 400, { ok: false, error });
}

async function readJsonBody(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stableHash(input) {
  let hash = 2166136261;
  for (const char of String(input || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function resolveAutomationScript(name) {
  const candidates = [
    path.join(AUTOMATION_SCRIPTS_ROOT, name),
  ];
  if (LEGACY_SKILL_ROOT) {
    candidates.push(path.join(LEGACY_SKILL_ROOT, "scripts", name));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error(`Automation script not found: ${name}. Set GEMSYNC_AUTOMATION_SCRIPTS to the scripts folder.`);
}

function folderTitleFromPath(input) {
  const resolved = path.resolve(String(input || ""));
  return path.basename(resolved) || "";
}

function sanitizeId(input, fallback = "subject") {
  const raw = String(input || fallback || "subject").trim();
  const ascii = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || `course-${stableHash(raw)}`;
}

function normalizeTitle(input, fallback = "未命名学科") {
  return String(input || fallback).trim() || fallback;
}

function normalizeModel(input, fallback = DEFAULT_GEMINI_MODEL) {
  const value = String(input || fallback || "").trim().toLowerCase().replace(/_/g, "-");
  if (["pro", "flash", "flash-lite"].includes(value)) return value;
  return fallback;
}

function normalizeProFallback(input, fallback = DEFAULT_PRO_FALLBACK) {
  const value = String(input || fallback || "").trim().toLowerCase().replace(/_/g, "-");
  if (["wait", "stop", "flash", "flash-lite"].includes(value)) return value;
  return fallback;
}

function deckIdFromNumber(number) {
  return `deck${String(number).padStart(2, "0")}`;
}

function deckNumberFromName(name) {
  return Number(/^deck(\d+)/i.exec(name || "")?.[1] || 0);
}

function titleFromDeckFolder(name) {
  return String(name || "")
    .replace(/^deck\d+[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    || String(name || "Deck");
}

function safeFolderPart(input) {
  return String(input || "deck")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    || "deck";
}

function comparableName(input) {
  return String(input || "")
    .replace(/\.[^.]+$/u, "")
    .replace(/^deck\d+[_-]?/i, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[()[\]{}（）【】《》,，.。:：;；]/g, "");
}

function conversationIdFromUrl(url) {
  try {
    return new URL(url).pathname.match(/^\/app\/([^/?#]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function withZh(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("hl")) parsed.searchParams.set("hl", "zh");
    return parsed.toString();
  } catch {
    return url;
  }
}

async function listFiles(dir, extensions) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name))
      .filter((file) => extensions.includes(path.extname(file).toLowerCase()))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN", { numeric: true }));
  } catch {
    return [];
  }
}

async function workspacePdfFiles(workspace) {
  const root = path.resolve(workspace || "");
  const screenshotRoot = path.join(root, "gemini_ppt_screenshots_full");
  const pdfs = [
    ...(await listFiles(root, [".pdf"])),
    ...(await listFiles(path.join(screenshotRoot, "_pdf"), [".pdf"])),
  ];
  return Array.from(new Set(pdfs))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN", { numeric: true }));
}

async function screenshotDecks(workspace) {
  const root = path.join(workspace, "gemini_ppt_screenshots_full");
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const decks = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^deck\d+_/i.test(entry.name)) continue;
      const folder = path.join(root, entry.name);
      const pngs = await listFiles(folder, [".png"]);
      decks.push({
        folder: entry.name,
        folderPath: folder,
        deckNumber: deckNumberFromName(entry.name),
        title: titleFromDeckFolder(entry.name),
        slides: pngs.length,
      });
    }
    return decks.sort((a, b) => a.deckNumber - b.deckNumber);
  } catch {
    return [];
  }
}

async function countPdfPages(file) {
  if (!fs.existsSync(PDFINFO)) return 0;
  return new Promise((resolve) => {
    const child = spawn(PDFINFO, [file], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const match = /^Pages:\s+(\d+)/m.exec(output);
      resolve(match ? Number(match[1]) : 0);
    });
  });
}

async function workspaceSummary(workspace) {
  const root = path.resolve(workspace || "");
  const pdfs = await workspacePdfFiles(root);
  const ppts = await listFiles(root, [".ppt", ".pptx"]);
  const screenshotRoot = path.join(root, "gemini_ppt_screenshots_full");
  const decks = await screenshotDecks(root);
  const progress = await readJson(path.join(screenshotRoot, "gemini_progress.json"), {});
  const conversationFolders = await readJson(path.join(screenshotRoot, "conversation_folders.json"), null);
  const manifest = await readJson(path.join(screenshotRoot, "manifest.json"), null);
  const manifestItems = Array.isArray(manifest)
    ? manifest
    : Array.isArray(manifest?.decks)
      ? manifest.decks
      : Array.isArray(manifest?.items)
        ? manifest.items
        : [];
  const sent = progress?.sent || {};
  const completedDeckCount = decks.filter((deck) => {
    const sentSlides = Number(sent[deck.folder] || 0);
    return deck.slides > 0 && sentSlides >= deck.slides;
  }).length;
  const sentSlides = decks.reduce((total, deck) => total + Number(sent[deck.folder] || 0), 0);
  const totalSlides = decks.reduce((total, deck) => total + Number(deck.slides || 0), 0);
  return {
    workspace: root,
    exists: fs.existsSync(root),
    pdfs: pdfs.map((file) => ({ name: path.basename(file), path: file })),
    ppts: ppts.map((file) => ({ name: path.basename(file), path: file })),
    screenshotRoot,
    screenshotRootExists: fs.existsSync(screenshotRoot),
    decks,
    progress: {
      sentCount: progress?.sent ? Object.keys(progress.sent).length : 0,
      completedDeckCount,
      incompleteDeckCount: Math.max(0, decks.length - completedDeckCount),
      sentSlides,
      totalSlides,
      conversationCount: progress?.conversations ? Object.keys(progress.conversations).length : 0,
      last: progress?.last || null,
      quotaWaiting: !!progress?.quotaWaiting,
    },
    conversationFoldersCount: Array.isArray(conversationFolders?.folders) ? conversationFolders.folders.length : 0,
    manifestCount: manifestItems.length,
  };
}

async function extensionSubjects(extensionRoot) {
  const subjectsPath = path.join(extensionRoot, "pdf-panel", "subjects.json");
  const subjects = await readJson(subjectsPath, { version: 1, defaultSubject: "", subjects: [] });
  return {
    extensionRoot,
    subjectsPath,
    subjects: subjects.subjects || [],
    defaultSubject: subjects.defaultSubject || "",
  };
}

function makeJob(type, title) {
  const id = `${Date.now().toString(36)}-${++jobSeq}`;
  const job = {
    id,
    type,
    title,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    log: "",
    pid: null,
    child: null,
  };
  jobs.set(id, job);
  return job;
}

function appendJob(job, text) {
  job.log += text;
  if (job.log.length > 200000) job.log = job.log.slice(-200000);
}

function runJob({ type, title, command, args, cwd, env = {}, logFiles = [] }) {
  const job = makeJob(type, title);
  appendJob(job, `WORKDIR ${cwd}\nRUN ${command} ${args.join(" ")}\n\n`);
  const outStreams = logFiles.map((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return fs.createWriteStream(file, { flags: "a" });
  });

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  job.child = child;
  job.pid = child.pid;

  const record = (chunk) => {
    const text = chunk.toString();
    appendJob(job, text);
    for (const stream of outStreams) stream.write(text);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.on("error", (error) => {
    appendJob(job, `\nERROR ${error.message}\n`);
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    for (const stream of outStreams) stream.end();
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.status = code === 0 ? "complete" : "failed";
    job.finishedAt = new Date().toISOString();
    appendJob(job, `\nEXIT ${code}\n`);
    for (const stream of outStreams) stream.end();
  });
  return job;
}

async function ensureRunner(workspace) {
  const source = resolveAutomationScript("gemini_ppt_one_by_one.mjs");
  const target = path.join(workspace, "gemini_ppt_one_by_one.mjs");
  await fsp.copyFile(source, target);
  return target;
}

async function prepareScreenshotsJob(body) {
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  const ppts = await listFiles(workspace, [".ppt", ".pptx"]);
  const pdfs = await workspacePdfFiles(workspace);
  const decks = await screenshotDecks(workspace);

  if (!ppts.length && pdfs.length) return preparePdfScreenshotsJob(workspace, pdfs, decks);

  const script = resolveAutomationScript("add_new_ppts_to_screenshots.py");
  const args = [script, "--workspace", workspace];
  if (body.dryRun) args.push("--dry-run");
  const requestedPpts = Array.isArray(body.ppts) && body.ppts.length
    ? body.ppts
    : (!decks.length ? ppts : []);
  for (const ppt of requestedPpts) args.push("--ppt", ppt);
  return runJob({
    type: "prepare",
    title: "准备 PPT 截图",
    command: PYTHON,
    args,
    cwd: workspace,
  });
}

function runProcess(job, command, args, cwd) {
  appendJob(job, `RUN ${command} ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    job.child = child;
    job.pid = child.pid;
    child.stdout.on("data", (chunk) => appendJob(job, chunk.toString()));
    child.stderr.on("data", (chunk) => appendJob(job, chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`命令退出失败：${code}`));
    });
  });
}

async function renamePdfImages(deckDir, deckId, prefix) {
  const files = (await listFiles(deckDir, [".png"]))
    .filter((file) => path.basename(file).startsWith(path.basename(prefix)))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN", { numeric: true }));

  for (let index = 0; index < files.length; index += 1) {
    const target = path.join(deckDir, `${deckId}_slide${String(index + 1).padStart(3, "0")}.png`);
    if (files[index] !== target) await fsp.rename(files[index], target);
  }
  return files.length;
}

function existingDeckForPdf(decks, pdfFile, index) {
  const deckNumber = index + 1;
  const title = comparableName(path.basename(pdfFile, ".pdf"));
  return decks.find((deck) => deck.deckNumber === deckNumber)
    || decks.find((deck) => {
      const deckTitle = comparableName(deck.title || deck.folder);
      return title && (deckTitle.includes(title) || title.includes(deckTitle));
    });
}

function preparePdfScreenshotsJob(workspace, pdfs, decks) {
  if (!fs.existsSync(PDFTOPPM)) throw new Error("找不到 pdftoppm，无法把 PDF 转成截图");

  const job = makeJob("prepare", "准备 PDF 截图");
  const screenshotRoot = path.join(workspace, "gemini_ppt_screenshots_full");

  (async () => {
    try {
      await fsp.mkdir(screenshotRoot, { recursive: true });
      appendJob(job, `WORKDIR ${workspace}\n`);
      appendJob(job, `PDFS ${pdfs.length}\n\n`);

      let created = 0;
      let skipped = 0;
      for (let index = 0; index < pdfs.length; index += 1) {
        const pdf = pdfs[index];
        const deckId = deckIdFromNumber(index + 1);
        const existing = existingDeckForPdf(decks, pdf, index);
        if (existing?.slides > 0) {
          skipped += 1;
          appendJob(job, `SKIP ${path.basename(pdf)} -> ${existing.folder} (${existing.slides} screenshots)\n`);
          continue;
        }

        const deckTitle = safeFolderPart(path.basename(pdf, ".pdf"));
        const deckFolder = `${deckId}_${deckTitle}`;
        const deckDir = path.join(screenshotRoot, deckFolder);
        await fsp.mkdir(deckDir, { recursive: true });

        const oldPngs = await listFiles(deckDir, [".png"]);
        for (const file of oldPngs) await fsp.unlink(file);

        appendJob(job, `PDF ${index + 1}/${pdfs.length}: ${path.basename(pdf)}\n`);
        const prefix = path.join(deckDir, `${deckId}_raw`);
        await runProcess(job, PDFTOPPM, ["-png", "-r", "150", pdf, prefix], workspace);
        const pages = await renamePdfImages(deckDir, deckId, prefix);
        appendJob(job, `DONE ${deckFolder}: ${pages} pages\n\n`);
        created += 1;
      }

      const manifest = {
        version: 1,
        source: "pdf",
        workspace,
        root: screenshotRoot,
        updatedAt: new Date().toISOString(),
        decks: (await screenshotDecks(workspace)).map((deck) => ({
          deck: deck.folder,
          folder: deck.folder,
          title: deck.title,
          totalSlides: deck.slides,
        })),
      };
      await writeJson(path.join(screenshotRoot, "manifest.json"), manifest);
      appendJob(job, `SUMMARY created=${created} skipped=${skipped}\n`);
      job.status = "complete";
      job.exitCode = 0;
    } catch (error) {
      appendJob(job, `ERROR ${error.message}\n`);
      job.status = "failed";
      job.exitCode = 1;
    } finally {
      job.child = null;
      job.pid = null;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

async function startGeminiJob(body) {
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  await ensureRunner(workspace);
  const screenshotRoot = path.join(workspace, "gemini_ppt_screenshots_full");
  await fsp.mkdir(screenshotRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const log = path.join(screenshotRoot, `manager_gemini_${stamp}.log`);
  const env = {
    GEMINI_PPT_ROOT: screenshotRoot,
    GEMINI_PPT_PROMPT: body.prompt || DEFAULT_PROMPT,
    GEMINI_MODEL: normalizeModel(body.model),
    GEMINI_PRO_FALLBACK: normalizeProFallback(body.proFallback),
  };
  if (body.maxSlides) env.MAX_SLIDES = String(body.maxSlides);
  return runJob({
    type: "gemini",
    title: "Gemini 自动提问",
    command: NODE,
    args: ["gemini_ppt_one_by_one.mjs"],
    cwd: workspace,
    env,
    logFiles: [log],
  });
}

async function backupJsonIfExists(file, backupDir, stamp) {
  if (!fs.existsSync(file)) return "";
  await fsp.mkdir(backupDir, { recursive: true });
  const backup = path.join(backupDir, `${path.basename(file, ".json")}-${stamp}.json`);
  await fsp.copyFile(file, backup);
  return backup;
}

async function resetGeminiProgress(body) {
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  const screenshotRoot = path.join(workspace, "gemini_ppt_screenshots_full");
  if (!fs.existsSync(screenshotRoot)) throw new Error("还没有截图目录，不能重置提问进度");

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupDir = path.join(screenshotRoot, "archives", "progress-backups");
  const progressPath = path.join(screenshotRoot, "gemini_progress.json");
  const foldersPath = path.join(screenshotRoot, "conversation_folders.json");
  const backups = [
    await backupJsonIfExists(progressPath, backupDir, stamp),
    await backupJsonIfExists(foldersPath, backupDir, stamp),
  ].filter(Boolean);

  const now = new Date().toISOString();
  const decks = await screenshotDecks(workspace);
  await writeJson(progressPath, {
    sent: {},
    conversations: {},
    renamedTitles: {},
    resetAt: now,
    updatedAt: now,
  });
  await writeJson(foldersPath, {
    version: 1,
    root: screenshotRoot,
    updatedAt: now,
    folders: decks.map((deck) => ({
      deck: deck.folder,
      folder: deck.folder,
      folderPath: deck.folderPath,
      title: deck.title,
      conversationUrl: "",
      sent: 0,
      totalSlides: deck.slides,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })),
  });

  return {
    workspace,
    screenshotRoot,
    decks: decks.length,
    backups,
    summary: await workspaceSummary(workspace),
  };
}

function findConversationForDeck(deck, index, progress, conversationFolders) {
  const folders = Array.isArray(conversationFolders?.folders) ? conversationFolders.folders : [];
  const byFolder = folders.find((item) => item.folder === deck.folder || item.deck === deck.folder);
  if (byFolder?.conversationUrl) return byFolder.conversationUrl;

  const conversations = progress?.conversations || {};
  if (conversations[deck.folder]) return conversations[deck.folder];

  const entries = Object.entries(conversations).sort(([a], [b]) => {
    const an = deckNumberFromName(a);
    const bn = deckNumberFromName(b);
    return an - bn;
  });
  const byDeckNumber = entries.find(([key]) => deckNumberFromName(key) === deck.deckNumber);
  if (byDeckNumber) return byDeckNumber[1];
  return entries[index]?.[1] || "";
}

function findPdfForDeck(pdfs, deck, index) {
  const deckNumber = deck.deckNumber || index + 1;
  const numberPattern = new RegExp(`(?:^|[^0-9])0*${deckNumber}(?:[^0-9]|$)`);
  const byNumber = pdfs.find((file) => numberPattern.test(path.basename(file, ".pdf")));
  if (byNumber) return byNumber;

  const deckTitle = comparableName(deck.title || deck.folder);
  const byTitle = pdfs.find((file) => {
    const name = comparableName(path.basename(file, ".pdf"));
    return deckTitle && (name.includes(deckTitle) || deckTitle.includes(name));
  });
  if (byTitle) return byTitle;

  return pdfs[index] || "";
}

async function ensureConversationFolders(screenshotRoot, decks, progress, conversationFolders) {
  if (!fs.existsSync(screenshotRoot) || !decks.length) return conversationFolders;

  const now = new Date().toISOString();
  const oldFolders = Array.isArray(conversationFolders?.folders) ? conversationFolders.folders : [];
  const oldByDeck = new Map();
  for (const item of oldFolders) {
    if (item?.folder) oldByDeck.set(item.folder, item);
    if (item?.deck) oldByDeck.set(item.deck, item);
  }

  const folders = decks.map((deck, index) => {
    const old = oldByDeck.get(deck.folder) || {};
    const conversationUrl = findConversationForDeck(deck, index, progress, conversationFolders);
    const totalSlides = deck.slides || old.totalSlides || 0;
    const sent = Number(progress?.sent?.[deck.folder] ?? old.sent ?? 0);
    const status = totalSlides > 0 && sent >= totalSlides
      ? "complete"
      : conversationUrl
        ? "in_progress"
        : "pending";
    return {
      deck: deck.folder,
      folder: deck.folder,
      folderPath: deck.folderPath || path.join(screenshotRoot, deck.folder),
      title: deck.title || titleFromDeckFolder(deck.folder),
      conversationUrl,
      sent,
      totalSlides,
      status,
      createdAt: old.createdAt || now,
      updatedAt: now,
    };
  });

  const next = {
    version: 1,
    root: screenshotRoot,
    updatedAt: now,
    folders,
  };
  await writeJson(path.join(screenshotRoot, "conversation_folders.json"), next);
  return next;
}

async function buildPluginSubject(body) {
  const workspace = path.resolve(body.workspace || "");
  const extensionRoot = DEFAULT_EXTENSION_ROOT;
  const title = normalizeTitle(body.title, folderTitleFromPath(workspace) || DEFAULT_SUBJECT_TITLE);
  const subjectId = sanitizeId(body.subjectId, title);
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  if (!fs.existsSync(extensionRoot)) throw new Error("插件目录不存在");

  const summary = await workspaceSummary(workspace);
  const screenshotRoot = path.join(workspace, "gemini_ppt_screenshots_full");
  const progress = await readJson(path.join(screenshotRoot, "gemini_progress.json"), {});
  let conversationFolders = await readJson(path.join(screenshotRoot, "conversation_folders.json"), null);
  const pdfs = await workspacePdfFiles(workspace);
  const decks = summary.decks.length
    ? summary.decks
    : pdfs.map((file, index) => ({
        folder: `${deckIdFromNumber(index + 1)}_${path.basename(file, ".pdf")}`,
        folderPath: "",
        deckNumber: index + 1,
        title: path.basename(file, ".pdf"),
        slides: 0,
      }));

  if (!decks.length) throw new Error("没有找到 PDF 或截图 deck");
  conversationFolders = await ensureConversationFolders(screenshotRoot, decks, progress, conversationFolders);

  const subjectRoot = path.join(extensionRoot, "pdf-panel", "subjects", subjectId);
  const pdfDir = path.join(subjectRoot, "pdfs");
  await fsp.mkdir(pdfDir, { recursive: true });

  const configDecks = [];
  for (let index = 0; index < decks.length; index += 1) {
    const deck = decks[index];
    const deckId = deckIdFromNumber(deck.deckNumber || index + 1);
    const sourcePdf = findPdfForDeck(pdfs, deck, index);
    if (!sourcePdf) {
      appendJob(body.job || { log: "" }, `WARN no PDF for ${deck.folder}\n`);
      continue;
    }
    const targetPdf = path.join(pdfDir, `${deckId}.pdf`);
    await fsp.copyFile(sourcePdf, targetPdf);
    const totalPages = deck.slides || await countPdfPages(sourcePdf);
    const geminiUrl = withZh(findConversationForDeck(deck, index, progress, conversationFolders));
    configDecks.push({
      id: deckId,
      title: deck.title || path.basename(sourcePdf, ".pdf"),
      pdfUrl: `./pdfs/${deckId}.pdf`,
      geminiUrl,
      conversationId: conversationIdFromUrl(geminiUrl),
      totalPages,
    });
  }

  const config = {
    version: 1,
    course: title,
    pagePrompt: DEFAULT_PROMPT,
    decks: configDecks,
  };
  await writeJson(path.join(subjectRoot, "config.json"), config);

  const subjectsPath = path.join(extensionRoot, "pdf-panel", "subjects.json");
  const subjectsConfig = await readJson(subjectsPath, { version: 1, defaultSubject: subjectId, subjects: [] });
  const entry = {
    id: subjectId,
    title,
    configUrl: `./subjects/${subjectId}/config.json`,
  };
  const subjects = (subjectsConfig.subjects || []).filter((item) => item.id !== subjectId);
  subjects.push(entry);
  subjectsConfig.version = 1;
  subjectsConfig.defaultSubject = subjectsConfig.defaultSubject || subjectId;
  subjectsConfig.subjects = subjects;
  await writeJson(subjectsPath, subjectsConfig);

  return {
    subjectId,
    title,
    subjectRoot,
    configPath: path.join(subjectRoot, "config.json"),
    conversationFoldersPath: path.join(screenshotRoot, "conversation_folders.json"),
    decks: configDecks.length,
    missingGeminiUrls: configDecks.filter((deck) => !deck.geminiUrl).length,
  };
}

async function updatePluginJob(body) {
  const job = makeJob("plugin", "更新插件学科库");
  try {
    const result = await buildPluginSubject({ ...body, job });
    appendJob(job, `UPDATED ${result.configPath}\n`);
    appendJob(job, `DECKS ${result.decks}\n`);
    if (result.missingGeminiUrls) appendJob(job, `WARN missing Gemini URLs: ${result.missingGeminiUrls}\n`);
    job.status = "complete";
    job.exitCode = 0;
    job.result = result;
  } catch (error) {
    appendJob(job, `ERROR ${error.message}\n`);
    job.status = "failed";
    job.exitCode = 1;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

async function chromeStatus() {
  try {
    const response = await fetch(`${CHROME_DEBUG_URL}/json/version`);
    const data = await response.json();
    return { ok: true, browser: data.Browser || "" };
  } catch {
    return { ok: false };
  }
}

async function openChromeDebugTab(url = GEMINI_URL) {
  const response = await fetch(`${CHROME_DEBUG_URL}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`无法在自动化 Chrome 里打开新标签页：${response.status}`);
  const target = await response.json();
  return {
    id: target.id || "",
    title: target.title || "",
    url: target.url || url,
  };
}

async function startChromeDebug(body) {
  const status = await chromeStatus();
  if (status.ok) {
    const tab = await openChromeDebugTab(GEMINI_URL);
    return { alreadyRunning: true, openedTab: true, tab, ...status };
  }
  const workspace = path.resolve(body.workspace || ROOT);
  const profile = path.join(workspace, "chrome-gemini-automation-profile");
  spawn(CHROME, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${profile}`,
    "--profile-directory=Default",
    "--no-first-run",
    GEMINI_URL,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
  return { alreadyRunning: false, openedTab: false, launched: true, profile };
}

async function pickFolder(body) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:GEMSYNC_PICKER_TITLE
$dialog.ShowNewFolderButton = $true
if ($env:GEMSYNC_PICKER_INITIAL -and (Test-Path -LiteralPath $env:GEMSYNC_PICKER_INITIAL)) {
  $dialog.SelectedPath = $env:GEMSYNC_PICKER_INITIAL
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.Width = 1
$owner.Height = 1
$owner.ShowInTaskbar = $false
$owner.Show()
$owner.Hide()
$result = $dialog.ShowDialog($owner)
$owner.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      env: {
        ...process.env,
        GEMSYNC_PICKER_TITLE: body.title || "选择文件夹",
        GEMSYNC_PICKER_INITIAL: body.initialPath || "",
      },
      windowsHide: false,
    });

    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || `文件夹选择器退出失败：${code}`));
        return;
      }
      resolve(output.trim());
    });
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/state") {
    const extension = await extensionSubjects(DEFAULT_EXTENSION_ROOT);
    sendJson(res, 200, {
      ok: true,
      defaults: {
        workspace: DEFAULT_WORKSPACE,
        subjectId: DEFAULT_SUBJECT_ID,
        subjectTitle: DEFAULT_SUBJECT_TITLE,
        prompt: DEFAULT_PROMPT,
        model: DEFAULT_GEMINI_MODEL,
        proFallback: DEFAULT_PRO_FALLBACK,
        extensionRoot: DEFAULT_EXTENSION_ROOT,
        automationScriptsRoot: AUTOMATION_SCRIPTS_ROOT,
        nodePath: NODE,
        pythonPath: PYTHON,
        pdfinfoPath: PDFINFO,
        pdftoppmPath: PDFTOPPM,
        chromePath: CHROME,
      },
      extension,
      jobs: [...jobs.values()].map(publicJob),
      chrome: await chromeStatus(),
    });
    return;
  }

  if (url.pathname === "/api/pick-folder" && req.method === "POST") {
    const folderPath = await pickFolder(await readJsonBody(req));
    sendJson(res, 200, { ok: true, path: folderPath, canceled: !folderPath });
    return;
  }

  if (url.pathname === "/api/scan" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, summary: await workspaceSummary(body.workspace) });
    return;
  }

  if (url.pathname === "/api/chrome/start" && req.method === "POST") {
    sendJson(res, 200, { ok: true, result: await startChromeDebug(await readJsonBody(req)) });
    return;
  }

  if (url.pathname === "/api/jobs/prepare" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await prepareScreenshotsJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/jobs/gemini" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await startGeminiJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/progress/reset" && req.method === "POST") {
    sendJson(res, 200, { ok: true, result: await resetGeminiProgress(await readJsonBody(req)) });
    return;
  }

  if (url.pathname === "/api/jobs/plugin" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await updatePluginJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/jobs") {
    sendJson(res, 200, { ok: true, jobs: [...jobs.values()].map(publicJob) });
    return;
  }

  const logMatch = /^\/api\/jobs\/([^/]+)\/log$/.exec(url.pathname);
  if (logMatch) {
    const job = jobs.get(decodeURIComponent(logMatch[1]));
    if (!job) return notFound(res);
    sendJson(res, 200, { ok: true, job: publicJob(job), log: job.log });
    return;
  }

  const clearLogMatch = /^\/api\/jobs\/([^/]+)\/log\/clear$/.exec(url.pathname);
  if (clearLogMatch && req.method === "POST") {
    const job = jobs.get(decodeURIComponent(clearLogMatch[1]));
    if (!job) return notFound(res);
    job.log = "";
    sendJson(res, 200, { ok: true, job: publicJob(job), log: job.log });
    return;
  }

  const stopMatch = /^\/api\/jobs\/([^/]+)\/stop$/.exec(url.pathname);
  if (stopMatch && req.method === "POST") {
    const job = jobs.get(decodeURIComponent(stopMatch[1]));
    if (!job) return notFound(res);
    if (job.child && job.status === "running") {
      job.child.kill();
      appendJob(job, "\nSTOP requested\n");
    }
    sendJson(res, 200, { ok: true, job: publicJob(job) });
    return;
  }

  notFound(res);
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    pid: job.pid,
    result: job.result || null,
  };
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/favicon.ico") {
    send(res, 204, "");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(APP_ROOT, `.${pathname}`);
  if (!file.startsWith(APP_ROOT)) return notFound(res);
  fs.readFile(file, (error, data) => {
    if (error) return notFound(res);
    send(res, 200, data, {
      "Content-Type": MIME.get(path.extname(file).toLowerCase()) || "application/octet-stream",
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      sendJson(res, 500, { ok: false, error: error.message });
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return badRequest(res, "Unsupported method");
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`GemSync Manager running at http://${HOST}:${PORT}`);
});
