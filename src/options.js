import { fetchReviewQueue, fetchUserRepos } from "./github.js";
import {
  DEFAULT_CHECK_LABEL,
  LOCAL,
  MIN_CHECK_SECONDS,
  MAX_CHECK_SECONDS,
  formatDuration,
  normalizeRepos,
  parseDurationToSeconds,
  readSettings,
  setDebugLogs,
  SYNC,
} from "./settings.js";

const tokenEl = document.getElementById("token");
const filterEl = document.getElementById("filter");
const listEl = document.getElementById("repo-list");
const emptyEl = document.getElementById("repo-empty");
const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const saveBtn = document.getElementById("save");
const loadBtn = document.getElementById("load-repos");
const selectVisibleBtn = document.getElementById("select-visible");
const clearVisibleBtn = document.getElementById("clear-visible");
const checkFreqEl = document.getElementById("check-freq");
const debugLogsEl = document.getElementById("debug-logs");
const runCheckBtn = document.getElementById("run-check");

/** @type {Map<string, boolean>} */
const repoState = new Map();

function selectedRepos() {
  return [...repoState.entries()]
    .filter(([, on]) => on)
    .map(([name]) => name)
    .sort();
}

function updateCount() {
  const n = selectedRepos().length;
  countEl.textContent = n ? `${n} selected` : "";
  emptyEl.hidden = repoState.size > 0;
}

function renderList() {
  const q = filterEl.value.trim().toLowerCase();
  const names = [...repoState.keys()].sort();
  listEl.innerHTML = "";
  for (const name of names) {
    const label = document.createElement("label");
    if (q && !name.includes(q)) label.hidden = true;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = name;
    input.checked = Boolean(repoState.get(name));
    input.addEventListener("change", () => {
      repoState.set(name, input.checked);
      updateCount();
    });
    const span = document.createElement("span");
    span.textContent = name;
    label.append(input, span);
    listEl.appendChild(label);
  }
  updateCount();
}

function visibleLabels() {
  return [...listEl.querySelectorAll("label")].filter((el) => !el.hidden);
}

function onDebug(...args) {
  if (!debugLogsEl.checked) return;
  console.log("[PRQ]", ...args);
}

async function load() {
  const settings = await readSettings();
  tokenEl.value = settings.token;
  repoState.clear();
  for (const name of settings.repos) repoState.set(name, true);
  renderList();
  checkFreqEl.value = settings.checkFreq || DEFAULT_CHECK_LABEL;
  debugLogsEl.checked = settings.debugLogs;
}

loadBtn.addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  if (!token) {
    statusEl.textContent = "Paste token first.";
    return;
  }
  loadBtn.disabled = true;
  statusEl.textContent = "Loading repos…";
  try {
    const selected = new Set(selectedRepos());
    const names = await fetchUserRepos(token, { onDebug });
    repoState.clear();
    for (const name of names) repoState.set(name, selected.has(name));
    for (const name of selected) {
      if (!repoState.has(name)) repoState.set(name, true);
    }
    renderList();
    statusEl.textContent = `Loaded ${names.length} repos. Check allowlist, then Save.`;
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    loadBtn.disabled = false;
  }
});

filterEl.addEventListener("input", () => {
  const q = filterEl.value.trim().toLowerCase();
  for (const label of listEl.querySelectorAll("label")) {
    const name = label.querySelector("input")?.value || "";
    label.hidden = Boolean(q && !name.includes(q));
  }
});

selectVisibleBtn.addEventListener("click", () => {
  for (const label of visibleLabels()) {
    const input = label.querySelector("input");
    if (!input) continue;
    input.checked = true;
    repoState.set(input.value, true);
  }
  updateCount();
});

clearVisibleBtn.addEventListener("click", () => {
  for (const label of visibleLabels()) {
    const input = label.querySelector("input");
    if (!input) continue;
    input.checked = false;
    repoState.set(input.value, false);
  }
  updateCount();
});

saveBtn.addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  const repos = selectedRepos();
  const checkFreq = checkFreqEl.value.trim() || DEFAULT_CHECK_LABEL;
  const checkSeconds = parseDurationToSeconds(checkFreq);
  const bad = repos.filter((r) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(r));
  if (bad.length) {
    statusEl.textContent = `Bad repo id: ${bad[0]}`;
    return;
  }
  if (!repos.length) {
    statusEl.textContent = "Select at least one repo.";
    return;
  }
  if (checkSeconds == null) {
    statusEl.textContent = "Bad frequency. Use 45s, 2m, 1h (unit required).";
    return;
  }
  if (checkSeconds < MIN_CHECK_SECONDS) {
    statusEl.textContent = `Frequency too short (min ${formatDuration(MIN_CHECK_SECONDS)}).`;
    return;
  }
  if (checkSeconds > MAX_CHECK_SECONDS) {
    statusEl.textContent = `Frequency too long (max ${formatDuration(MAX_CHECK_SECONDS)}).`;
    return;
  }
  const normalized = formatDuration(checkSeconds);
  checkFreqEl.value = normalized;
  await chrome.storage.sync.set({
    [SYNC.token]: token,
    [SYNC.repos]: repos,
    [SYNC.checkSeconds]: checkSeconds,
    [SYNC.checkFreq]: normalized,
    [SYNC.debugLogs]: debugLogsEl.checked,
  });
  statusEl.textContent = "Saved.";
  chrome.runtime
    .sendMessage({ type: "SET_CHECK_FREQUENCY", seconds: checkSeconds })
    .catch(() => {});
  chrome.runtime
    .sendMessage({ type: "GET_QUEUE", force: true })
    .catch(() => {});
});

debugLogsEl.addEventListener("change", async () => {
  await setDebugLogs(debugLogsEl.checked);
});

// Background schedule + fetch logs (when this Options page is open).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "PRQ_CONSOLE") return;
  if (!debugLogsEl.checked) return;
  console.log("[PRQ]", ...(Array.isArray(msg.args) ? msg.args : []));
});

/** Persist queue via SW; fall back if SW build is stale mid-reload. */
async function persistQueueItems(items) {
  const res = await chrome.runtime
    .sendMessage({ type: "PERSIST_QUEUE", items })
    .catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  if (res?.ok) return res;

  const at = Date.now();
  await chrome.storage.local.set({
    [LOCAL.queueItems]: items,
    [LOCAL.queueAt]: at,
    [LOCAL.queueError]: "",
    [LOCAL.queueReady]: true,
  });
  await chrome.runtime
    .sendMessage({ type: "UPDATE_BADGE", count: items.length })
    .catch(() => {});
  return { ok: true, at, count: items.length };
}

runCheckBtn.addEventListener("click", async () => {
  statusEl.textContent = "Running queue check…";
  runCheckBtn.disabled = true;
  try {
    const settings = await readSettings();
    const token = tokenEl.value.trim() || settings.token;
    const repos = selectedRepos().length ? selectedRepos() : settings.repos;
    const items = await fetchReviewQueue(token, normalizeRepos(repos), {
      onDebug,
    });
    await persistQueueItems(items);
    statusEl.textContent = `Queue check done (${items.length} pull requests).`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[PRQ]", "queue check failed", message);
    statusEl.textContent = message;
  } finally {
    runCheckBtn.disabled = false;
  }
});

load();
