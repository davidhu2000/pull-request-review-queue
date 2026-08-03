(() => {
  if (window.__prReviewQueueLoaded) return;
  window.__prReviewQueueLoaded = true;

  const QUEUE_ITEMS_KEY = "queueItems";

  const root = document.createElement("div");
  root.id = "prq-root";

  const toast = document.createElement("div");
  toast.id = "prq-toast";

  const nextBtn = document.createElement("button");
  nextBtn.id = "prq-next";
  nextBtn.type = "button";
  nextBtn.textContent = "Next PR";
  nextBtn.title = "Next in review queue (Alt+Shift+N)";
  nextBtn.disabled = true;

  root.append(toast, nextBtn);
  document.documentElement.appendChild(root);

  let toastTimer = 0;
  let loading = false;

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add("prq-show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("prq-show"), 2500);
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

  /** @param {string | undefined} url */
  function parsePrUrl(url) {
    if (!url) return null;
    const m = url.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
    );
    if (!m) return null;
    return { repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) };
  }

  /**
   * @param {unknown[]} items
   * @param {string} currentUrl
   */
  function hasNext(items, currentUrl) {
    const cur = parsePrUrl(currentUrl);
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = /** @type {{ repo?: string, number?: number }} */ (raw);
      if (
        cur &&
        String(item.repo || "").toLowerCase() === cur.repo &&
        Number(item.number) === cur.number
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  async function syncNextButton() {
    if (loading) return;
    try {
      const data = await chrome.storage.local.get(QUEUE_ITEMS_KEY);
      const items = Array.isArray(data[QUEUE_ITEMS_KEY])
        ? data[QUEUE_ITEMS_KEY]
        : [];
      const enabled = hasNext(items, location.href);
      nextBtn.disabled = !enabled;
      nextBtn.title = enabled
        ? "Next in review queue (Alt+Shift+N)"
        : "Queue clear";
    } catch {
      nextBtn.disabled = true;
      nextBtn.title = "Queue clear";
    }
  }

  async function goNext() {
    if (nextBtn.disabled || loading) return;
    loading = true;
    nextBtn.disabled = true;
    nextBtn.textContent = "Loading…";
    try {
      const res = await send({ type: "NEXT", currentUrl: location.href });
      if (!res.ok) {
        showToast(res.error || "Queue error");
        return;
      }
      if (res.next?.url) {
        location.href = res.next.url;
        return;
      }
      showToast("Queue clear");
    } finally {
      loading = false;
      nextBtn.textContent = "Next PR";
      await syncNextButton();
    }
  }

  nextBtn.addEventListener("click", () => goNext());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[QUEUE_ITEMS_KEY]) return;
    void syncNextButton();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOAST" && msg.text) showToast(msg.text);
  });

  void syncNextButton();
})();
