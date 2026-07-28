/** Shared settings + storage keys (options / popup / service worker). */

export const SYNC = {
  token: "token",
  repos: "repos",
  checkSeconds: "checkSeconds",
  checkFreq: "checkFreq",
  checkMinutes: "checkMinutes", // legacy — migrated on read
  debugLogs: "debugLogs",
};

export const LOCAL = {
  queueItems: "queueItems",
  queueAt: "queueAt",
  queueError: "queueError",
  queueReady: "queueReady",
};

export const DEFAULT_CHECK_SECONDS = 120;
export const DEFAULT_CHECK_LABEL = "2m";
export const MIN_CHECK_SECONDS = 15;
export const MAX_CHECK_SECONDS = 24 * 60 * 60;

export function clampCheckSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHECK_SECONDS;
  return Math.min(
    MAX_CHECK_SECONDS,
    Math.max(MIN_CHECK_SECONDS, Math.round(n)),
  );
}

function unitToSeconds(unit) {
  const u = unit.toLowerCase();
  if (u.startsWith("s")) return 1;
  if (u.startsWith("h")) return 3600;
  return 60;
}

/** @param {string} raw @returns {number | null} */
export function parseDurationToSeconds(raw) {
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const parts = [
    ...s.matchAll(
      /(\d+(?:\.\d+)?)(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)/g,
    ),
  ];
  if (parts.length === 0) return null;
  const rebuilt = parts.map((p) => p[0]).join("");
  if (rebuilt !== s) return null;
  let total = 0;
  for (const p of parts) total += Number(p[1]) * unitToSeconds(p[2]);
  return total > 0 ? total : null;
}

/** @param {number} seconds */
export function formatDuration(seconds) {
  const sec = Math.round(seconds);
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  if (sec > 60 && sec % 60 !== 0) {
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return `${m}m${r}s`;
  }
  return `${sec}s`;
}

/** @param {unknown} raw @returns {string[]} */
export function normalizeRepos(raw) {
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\n,\s]+/);
  return [
    ...new Set(
      list
        .map((r) =>
          String(r)
            .trim()
            .replace(/^https?:\/\/github\.com\//i, "")
            .replace(/\.git$/, "")
            .toLowerCase(),
        )
        .filter((r) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(r)),
    ),
  ];
}

/**
 * @typedef {{
 *   token: string,
 *   repos: string[],
 *   checkSeconds: number,
 *   checkFreq: string,
 *   debugLogs: boolean,
 * }} Settings
 */

/** @returns {Promise<Settings>} */
export async function readSettings() {
  const data = await chrome.storage.sync.get([
    SYNC.token,
    SYNC.repos,
    SYNC.checkSeconds,
    SYNC.checkFreq,
    SYNC.checkMinutes,
    SYNC.debugLogs,
  ]);

  const token = String(data[SYNC.token] || "").trim();
  const repos = normalizeRepos(data[SYNC.repos] || []);

  let checkSeconds = Number(data[SYNC.checkSeconds]);
  if (!Number.isFinite(checkSeconds) || checkSeconds <= 0) {
    const legacyMins = Number(data[SYNC.checkMinutes]);
    checkSeconds =
      Number.isFinite(legacyMins) && legacyMins > 0
        ? legacyMins * 60
        : DEFAULT_CHECK_SECONDS;
  }
  checkSeconds = clampCheckSeconds(checkSeconds);

  let checkFreq =
    typeof data[SYNC.checkFreq] === "string" && data[SYNC.checkFreq].trim()
      ? data[SYNC.checkFreq].trim()
      : formatDuration(checkSeconds);

  const debugLogs = Boolean(data[SYNC.debugLogs]);

  // Migrate legacy minutes → seconds once.
  if (data[SYNC.checkMinutes] != null && !Number(data[SYNC.checkSeconds])) {
    chrome.storage.sync
      .set({ [SYNC.checkSeconds]: checkSeconds, [SYNC.checkFreq]: checkFreq })
      .catch(() => {});
  }

  return { token, repos, checkSeconds, checkFreq, debugLogs };
}

/** @param {boolean} on */
export async function setDebugLogs(on) {
  await chrome.storage.sync.set({ [SYNC.debugLogs]: on });
}
