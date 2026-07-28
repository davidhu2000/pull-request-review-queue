import { fetchReviewQueue } from "./github.js";
import {
  LOCAL,
  SYNC,
  clampCheckSeconds,
  readSettings,
} from "./settings.js";

/** @typedef {import("./github.js").QueueItem} QueueItem */

/** @type {{ at: number, items: QueueItem[] } | null} */
let cache = null;

/** @type {Promise<QueueItem[]> | null} */
let inflight = null;

/** Serialize storage + badge writes so concurrent fetches can't desync them. */
let persistChain = Promise.resolve();

const REFRESH_ALARM = "refresh-queue";

/**
 * Repeating alarm only — Chrome persists these; one-shots / custom `when` were unreliable.
 * @param {number} [seconds]
 * @param {{ force?: boolean }} [opts]
 */
async function ensureRefreshAlarm(seconds, { force = false } = {}) {
  const periodSec = clampCheckSeconds(
    seconds ?? (await readSettings()).checkSeconds,
  );
  // Chrome floor ~30s (0.5 min).
  const periodInMinutes = Math.max(periodSec / 60, 0.5);

  if (!force) {
    const existing = await chrome.alarms.get(REFRESH_ALARM);
    if (
      existing &&
      typeof existing.periodInMinutes === "number" &&
      Math.abs(existing.periodInMinutes - periodInMinutes) < 0.001
    ) {
      await debugLog("schedule keep", {
        periodInMinutes,
        next: existing.scheduledTime
          ? new Date(existing.scheduledTime).toISOString()
          : null,
      });
      return;
    }
  }

  await chrome.alarms.clear(REFRESH_ALARM);
  // delayInMinutes = first fire; periodInMinutes = repeat.
  await chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
  const created = await chrome.alarms.get(REFRESH_ALARM);
  await debugLog("schedule set", {
    periodInMinutes,
    force,
    next: created?.scheduledTime
      ? new Date(created.scheduledTime).toISOString()
      : null,
  });
}

/** If last check is older than the configured interval, fetch now. */
async function catchUpIfOverdue() {
  const { checkSeconds } = await readSettings();
  await hydrateCacheFromStorage();
  const ageMs = cache ? Date.now() - cache.at : Infinity;
  if (ageMs < checkSeconds * 1000) {
    await debugLog("catch-up skip", {
      ageSec: Math.round(ageMs / 1000),
      checkSeconds,
    });
    return false;
  }
  await debugLog("catch-up run", {
    ageSec: Math.round(ageMs / 1000),
    checkSeconds,
  });
  try {
    await getQueue({ force: true });
    return true;
  } catch (err) {
    await debugLog(
      "catch-up failed",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

async function debugEnabled() {
  const { debugLogs } = await readSettings();
  return debugLogs;
}

/** @param {...unknown} args */
async function debugLog(...args) {
  if (!(await debugEnabled())) return;
  console.log("[PRQ]", ...args);
  try {
    const payload = JSON.parse(JSON.stringify(args));
    chrome.runtime.sendMessage({ type: "PRQ_CONSOLE", args: payload }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // ignore relay failures (no listener / non-cloneable)
  }
}

/** @param {QueueItem[]} items */
async function persistQueue(items, error = "") {
  const run = async () => {
    const at = Date.now();
    cache = { at, items };
    await chrome.storage.local.set({
      [LOCAL.queueItems]: items,
      [LOCAL.queueAt]: at,
      [LOCAL.queueError]: error,
      [LOCAL.queueReady]: true,
    });
    await updateBadge(items.length);
    return at;
  };
  const done = persistChain.then(run, run);
  persistChain = done.catch(() => {});
  return done;
}

async function hydrateCacheFromStorage() {
  const data = await chrome.storage.local.get([
    LOCAL.queueItems,
    LOCAL.queueAt,
  ]);
  if (!Array.isArray(data[LOCAL.queueItems])) return cache;
  const at = Number(data[LOCAL.queueAt]) || 0;
  // Prefer storage when newer or memory empty (Options / other writer).
  if (!cache || at >= cache.at) {
    cache = { at: at || Date.now(), items: data[LOCAL.queueItems] };
  }
  return cache;
}

/** @returns {Promise<{ items: QueueItem[], at: number, error: string } | null>} */
async function readCachedQueue() {
  const mem = await hydrateCacheFromStorage();
  if (!mem) return null;
  const data = await chrome.storage.local.get(LOCAL.queueError);
  return {
    items: mem.items,
    at: mem.at,
    error: data[LOCAL.queueError] || "",
  };
}

/**
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<QueueItem[]>}
 */
async function getQueue({ force = false } = {}) {
  await hydrateCacheFromStorage();
  const settings = await readSettings();
  if (!force && cache && Date.now() - cache.at < settings.checkSeconds * 1000) {
    return cache.items;
  }

  if (inflight) {
    if (!force) return inflight;
    // Don't reuse a pre-approve in-flight response for a forced refresh.
    try {
      await inflight;
    } catch {
      /* ignore */
    }
    // Another forced fetch may have started while we waited.
    if (inflight) return inflight;
  }

  const p = (async () => {
    try {
      await debugLog("queue fetch start", { force });
      const onDebug = (...args) => {
        void debugLog(...args);
      };
      const items = await fetchReviewQueue(settings.token, settings.repos, {
        onDebug,
      });
      await persistQueue(items, "");
      await debugLog("queue fetch done", { count: items.length, force });
      return items;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await debugLog("queue fetch failed", message);
      await chrome.storage.local.set({ [LOCAL.queueError]: message });
      if (cache?.items) return cache.items;
      throw err;
    }
  })();

  inflight = p;
  try {
    return await p;
  } finally {
    if (inflight === p) inflight = null;
  }
}

async function updateBadge(count) {
  const text = count > 0 ? String(Math.min(count, 99)) : "";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#1f883d" });
}

/** @param {string | undefined} currentUrl */
function parsePrUrl(currentUrl) {
  if (!currentUrl) return null;
  const m = currentUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
  );
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) };
}

/**
 * @param {QueueItem[]} items
 * @param {string | undefined} currentUrl
 */
function nextFromQueue(items, currentUrl) {
  const cur = parsePrUrl(currentUrl);
  for (const item of items) {
    if (cur && item.repo === cur.repo && item.number === cur.number) continue;
    return item;
  }
  return null;
}

/** @param {string | undefined} currentUrl */
async function getNext(currentUrl) {
  const items = await getQueue({ force: true });
  return { next: nextFromQueue(items, currentUrl), remaining: items.length };
}

function warmQueue({ force = false } = {}) {
  getQueue({ force }).catch(async () => {
    const cached = await readCachedQueue();
    await updateBadge(cached?.items.length || 0);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_QUEUE") {
        if (msg.cachedOnly) {
          const cached = await readCachedQueue();
          sendResponse({
            ok: true,
            items: cached?.items || [],
            at: cached?.at || 0,
            error: cached?.error || "",
            fromCache: true,
            hasCache: cached !== null,
          });
          return;
        }
        const items = await getQueue({ force: Boolean(msg.force) });
        const at = cache?.at || Date.now();
        sendResponse({ ok: true, items, at, fromCache: false, hasCache: true });
        return;
      }

      if (msg?.type === "PERSIST_QUEUE") {
        const items = Array.isArray(msg.items) ? msg.items : [];
        const at = await persistQueue(items, msg.error || "");
        sendResponse({ ok: true, count: items.length, at });
        return;
      }

      // Options wrote storage itself (stale-SW fallback) — sync memory + badge from storage only.
      if (msg?.type === "UPDATE_BADGE") {
        cache = null;
        const cached = await readCachedQueue();
        const count = cached?.items.length ?? (Number(msg.count) || 0);
        if (cached) cache = { at: cached.at, items: cached.items };
        await updateBadge(count);
        sendResponse({ ok: true, count });
        return;
      }

      if (msg?.type === "NEXT" || msg?.type === "GET_NEXT") {
        sendResponse({ ok: true, ...(await getNext(msg.currentUrl)) });
        return;
      }

      // Review submitted on a PR page: drop it from cache now, refetch after search lag.
      if (msg?.type === "REVIEW_SUBMITTED") {
        const cur = parsePrUrl(msg.currentUrl);
        await hydrateCacheFromStorage();
        let removed = false;
        if (cache && cur) {
          const nextItems = cache.items.filter(
            (item) => !(item.repo === cur.repo && item.number === cur.number),
          );
          removed = nextItems.length !== cache.items.length;
          if (removed) await persistQueue(nextItems, "");
        }
        await debugLog("review submitted", {
          repo: cur?.repo,
          number: cur?.number,
          removed,
        });
        // GitHub search index often lags a few seconds.
        chrome.alarms.create("post-review-refresh", { delayInMinutes: 0.05 });
        sendResponse({ ok: true, removed });
        return;
      }

      if (msg?.type === "SET_CHECK_FREQUENCY") {
        const seconds = clampCheckSeconds(msg.seconds);
        await ensureRefreshAlarm(seconds, { force: true });
        warmQueue({ force: true });
        sendResponse({ ok: true, seconds });
        return;
      }

      // Popup: fetch only if the configured interval was missed.
      // Do NOT force-recreate alarm here — that resets delayInMinutes every tick
      // while overdue and can prevent the alarm from ever firing.
      if (msg?.type === "ENSURE_SCHEDULE") {
        const caughtUp = await catchUpIfOverdue();
        const { checkSeconds } = await readSettings();
        await ensureRefreshAlarm(checkSeconds);
        const cached = await readCachedQueue();
        const alarm = await chrome.alarms.get(REFRESH_ALARM);
        await debugLog("ensure schedule", {
          caughtUp,
          checkSeconds,
          next: alarm?.scheduledTime
            ? new Date(alarm.scheduledTime).toISOString()
            : null,
        });
        sendResponse({
          ok: true,
          caughtUp,
          items: cached?.items || [],
          at: cached?.at || 0,
          nextAlarm: alarm?.scheduledTime || 0,
        });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message" });
    } catch (err) {
      console.error("[PRQ]", err);
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "next-pr") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentUrl = tab?.url;
  try {
    const { next, remaining } = await getNext(currentUrl);
    if (next) {
      if (tab?.id) await chrome.tabs.update(tab.id, { url: next.url });
      else await chrome.tabs.create({ url: next.url });
    } else if (tab?.id) {
      await chrome.tabs
        .sendMessage(tab.id, { type: "TOAST", text: "Queue clear" })
        .catch(() => {});
      await updateBadge(remaining || 0);
    }
  } catch (err) {
    if (tab?.id) {
      await chrome.tabs
        .sendMessage(tab.id, {
          type: "TOAST",
          text: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {});
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes[SYNC.token] || changes[SYNC.repos]) {
    cache = null;
    warmQueue({ force: true });
  }
  if (changes[SYNC.checkSeconds]) {
    ensureRefreshAlarm(Number(changes[SYNC.checkSeconds].newValue), {
      force: true,
    });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await readSettings();
  // Persist explicit defaults so unset ≠ three-state forever.
  await chrome.storage.sync.set({
    [SYNC.checkSeconds]: settings.checkSeconds,
    [SYNC.checkFreq]: settings.checkFreq,
  });
  warmQueue({ force: true });
  await ensureRefreshAlarm(settings.checkSeconds, { force: true });
});

chrome.runtime.onStartup.addListener(async () => {
  const { checkSeconds } = await readSettings();
  warmQueue({ force: true });
  await ensureRefreshAlarm(checkSeconds, { force: true });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REFRESH_ALARM && alarm.name !== "post-review-refresh") {
    return;
  }
  // Keep listener sync-return fast; do work in async IIFE (MV3 best practice).
  (async () => {
    await debugLog("alarm fired", {
      name: alarm.name,
      time: new Date().toISOString(),
    });
    try {
      await getQueue({ force: true });
    } catch (err) {
      await debugLog(
        "alarm fetch failed",
        err instanceof Error ? err.message : String(err),
      );
      const cached = await readCachedQueue();
      await updateBadge(cached?.items.length || 0);
    }
  })();
});

(async () => {
  try {
    const cached = await hydrateCacheFromStorage();
    if (cached) updateBadge(cached.items.length);
    const { checkSeconds } = await readSettings();
    // Always re-create on SW boot so a bad/missing alarm cannot stick forever.
    await ensureRefreshAlarm(checkSeconds, { force: true });
    await catchUpIfOverdue();
    await debugLog("sw ready", {
      checkSeconds,
      cacheAgeSec: cached ? Math.round((Date.now() - cached.at) / 1000) : null,
      alarm: await chrome.alarms.get(REFRESH_ALARM),
    });
  } catch (err) {
    console.error("[PRQ] sw boot failed", err);
  }
})();
