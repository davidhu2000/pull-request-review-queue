import { DEFAULT_CHECK_SECONDS, LOCAL, readSettings } from "./settings.js";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const metaTextEl = document.getElementById("meta-text");
const loadingEl = document.getElementById("loading");
const optionsLink = document.getElementById("options");
const refreshBtn = document.getElementById("refresh");

optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refreshBtn.addEventListener("click", () => {
  void manualRefresh();
});

/** @type {{ items: unknown[], checkedAt: number, error: string, refreshing: boolean } | null} */
let view = null;
let checkSeconds = DEFAULT_CHECK_SECONDS;
let ensureInFlight = false;
let manualInFlight = false;

function syncRefreshButton() {
  const busy = Boolean(view?.refreshing || ensureInFlight || manualInFlight);
  refreshBtn.disabled = busy;
  refreshBtn.classList.toggle("spinning", busy);
}

function setRefreshing(_on) {
  syncRefreshButton();
}

function setBootLoading(on) {
  loadingEl.classList.toggle("show", on);
}

function updateCheckedMeta() {
  if (!view) return;
  if (view.error && !view.items.length) return;
  if (view.refreshing && !view.items.length) {
    metaTextEl.textContent = "";
    return;
  }

  let suffix = "";
  if (view.refreshing) {
    suffix = " · checking…";
  } else if (view.checkedAt) {
    suffix = ` · checked ${formatCheckedAt(view.checkedAt)}`;
  }

  metaTextEl.textContent = view.items.length
    ? `${view.items.length} waiting${suffix}`
    : `Queue clear${suffix}`;
}

function render(items, { refreshing = false, error = "", checkedAt = 0 } = {}) {
  view = { items, checkedAt, error, refreshing };
  const bootLoad = refreshing && !items.length && !error;
  setBootLoading(bootLoad);
  setRefreshing(refreshing && !bootLoad);

  if (error && !items.length) {
    errorEl.textContent = error;
    errorEl.classList.add("show");
    emptyEl.classList.remove("show");
    listEl.replaceChildren();
    metaTextEl.textContent = "";
    return;
  }

  if (error) {
    errorEl.textContent = error;
    errorEl.classList.add("show");
  } else {
    errorEl.textContent = "";
    errorEl.classList.remove("show");
  }

  updateCheckedMeta();

  emptyEl.classList.toggle("show", !items.length && !error && !refreshing);
  if (!items.length) {
    listEl.replaceChildren();
    return;
  }

  emptyEl.classList.remove("show");
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = `<span class="title"></span><span class="sub"></span>`;
    a.querySelector(".title").textContent = item.title;
    a.querySelector(".sub").textContent =
      `${item.repo}#${item.number} · updated ${formatUpdated(item.updatedAt)}`;
    li.appendChild(a);
    frag.appendChild(li);
  }
  listEl.replaceChildren(frag);
}

/** Relative age for queue check timestamp — second precision. */
function formatCheckedAt(isoOrMs) {
  if (isoOrMs == null || isoOrMs === "") return "unknown";
  const then = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  if (Number.isNaN(then)) return "unknown";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const r = sec % 60;
    return r ? `${min}m ${r}s ago` : `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(then).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** @param {string | number | undefined} isoOrMs */
function formatUpdated(isoOrMs) {
  if (isoOrMs == null || isoOrMs === "") return "unknown";
  const then = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  if (Number.isNaN(then)) return "unknown";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: "No response" });
    });
  });
}

async function readLocalQueue() {
  const local = await chrome.storage.local.get([
    LOCAL.queueItems,
    LOCAL.queueAt,
    LOCAL.queueError,
    LOCAL.queueReady,
  ]);
  return {
    items: Array.isArray(local[LOCAL.queueItems])
      ? local[LOCAL.queueItems]
      : null,
    at: Number(local[LOCAL.queueAt]) || 0,
    error: local[LOCAL.queueError] || "",
    ready:
      Boolean(local[LOCAL.queueReady]) ||
      Array.isArray(local[LOCAL.queueItems]),
  };
}

/** First-run / manual refresh. */
async function refreshQueue() {
  const res = await send({ type: "GET_QUEUE", force: true });
  if (!res.ok) {
    const { items, at } = await readLocalQueue();
    if (items !== null) {
      render(items, { checkedAt: at, error: res.error || "Refresh failed" });
      return;
    }
    render([], { error: res.error || "Failed to load queue" });
    return;
  }
  render(res.items || [], { checkedAt: res.at || Date.now() });
}

async function manualRefresh() {
  if (manualInFlight || ensureInFlight || view?.refreshing) return;
  manualInFlight = true;
  syncRefreshButton();
  render(view?.items || [], {
    checkedAt: view?.checkedAt || 0,
    refreshing: true,
    error: view?.error || "",
  });
  try {
    await refreshQueue();
  } finally {
    manualInFlight = false;
    syncRefreshButton();
  }
}

/**
 * If past check frequency, ask SW to run the missed scheduled check.
 * Does nothing when still within the interval (not "check on every open").
 */
async function ensureScheduleIfOverdue() {
  if (!view?.checkedAt || view.refreshing || ensureInFlight) return;
  if (Date.now() - view.checkedAt < checkSeconds * 1000) return;

  ensureInFlight = true;
  render(view.items, {
    checkedAt: view.checkedAt,
    refreshing: true,
    error: view.error,
  });
  try {
    const res = await send({ type: "ENSURE_SCHEDULE" });
    if (res.ok) {
      render(res.items || [], {
        checkedAt: res.at || Date.now(),
        error: view.error,
      });
    } else {
      render(view.items, {
        checkedAt: view.checkedAt,
        error: res.error || view.error,
      });
    }
  } finally {
    ensureInFlight = false;
  }
}

async function boot() {
  const [{ items, at, error, ready }, settings] = await Promise.all([
    readLocalQueue(),
    readSettings(),
  ]);
  checkSeconds = settings.checkSeconds;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      !changes[LOCAL.queueItems] &&
      !changes[LOCAL.queueError] &&
      !changes[LOCAL.queueAt]
    ) {
      return;
    }
    if (ensureInFlight || view?.refreshing) return;
    readLocalQueue().then(({ items: next, at: nextAt, error: nextError }) => {
      if (next === null) return;
      render(next, {
        checkedAt: nextAt,
        error: nextError && !next.length ? nextError : "",
      });
    });
  });

  if (ready && items !== null) {
    render(items, {
      checkedAt: at,
      error: error && !items.length ? error : "",
    });
    // Only hits network if interval already elapsed.
    await ensureScheduleIfOverdue();
    return;
  }

  render([], { refreshing: true });
  await refreshQueue();
}

window.setInterval(() => {
  updateCheckedMeta();
  ensureScheduleIfOverdue();
}, 1000);
boot();
