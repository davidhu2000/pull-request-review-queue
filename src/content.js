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
  let lastSubmitAt = 0;
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

  /** @param {Element | null} el */
  function isReviewSubmitControl(el) {
    if (!el) return false;
    const btn = el.closest(
      'button, input[type="submit"], [role="button"], summary',
    );
    if (!btn || btn.closest("#prq-root")) return false;

    const name = (btn.getAttribute("name") || "").toLowerCase();
    if (name.includes("pull_request_review")) return true;

    const form = btn.closest("form");
    const action = (form?.getAttribute("action") || "").toLowerCase();
    if (/\/pull\/\d+\/reviews?\b/.test(action)) return true;

    const label = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.value || ""}`
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (label === "submit review" || label.includes("submit review")) {
      return true;
    }
    return false;
  }

  function notifyReviewSubmitted() {
    const now = Date.now();
    if (now - lastSubmitAt < 2500) return;
    lastSubmitAt = now;
    void send({ type: "REVIEW_SUBMITTED", currentUrl: location.href }).then(
      () => syncNextButton(),
    );
  }

  document.addEventListener(
    "click",
    (ev) => {
      if (!(ev.target instanceof Element)) return;
      if (isReviewSubmitControl(ev.target)) notifyReviewSubmitted();
    },
    true,
  );

  document.addEventListener(
    "submit",
    (ev) => {
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;
      const action = (form.getAttribute("action") || "").toLowerCase();
      if (/\/pull\/\d+\/reviews?\b/.test(action)) notifyReviewSubmitted();
    },
    true,
  );

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
