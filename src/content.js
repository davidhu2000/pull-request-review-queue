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

  const approveNextBtn = document.createElement("button");
  approveNextBtn.id = "prq-approve-next";
  approveNextBtn.type = "button";
  approveNextBtn.textContent = "Approve and Next PR";
  approveNextBtn.title = "Approve this pull request and open the next one";
  approveNextBtn.disabled = true;

  const actions = document.createElement("div");
  actions.id = "prq-actions";
  actions.append(approveNextBtn, nextBtn);

  root.append(toast, actions);
  document.documentElement.appendChild(root);

  let toastTimer = 0;
  let loading = false;
  let currentApproved = false;

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add("prq-show");
    window.clearTimeout(toastTimer);
    const duration = text.length > 80 ? 7000 : 2500;
    toastTimer = window.setTimeout(
      () => toast.classList.remove("prq-show"),
      duration,
    );
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

  /**
   * @param {unknown[]} items
   * @param {string} currentUrl
   */
  function hasCurrent(items, currentUrl) {
    const cur = parsePrUrl(currentUrl);
    if (!cur) return false;
    return items.some((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const item = /** @type {{ repo?: string, number?: number }} */ (raw);
      return (
        String(item.repo || "").toLowerCase() === cur.repo &&
        Number(item.number) === cur.number
      );
    });
  }

  async function syncNextButton() {
    if (loading) return;
    try {
      const data = await chrome.storage.local.get(QUEUE_ITEMS_KEY);
      const items = Array.isArray(data[QUEUE_ITEMS_KEY])
        ? data[QUEUE_ITEMS_KEY]
        : [];
      const enabled = hasNext(items, location.href);
      const canApprove = hasCurrent(items, location.href) && !currentApproved;
      nextBtn.disabled = !enabled;
      approveNextBtn.disabled = !canApprove;
      approveNextBtn.title = canApprove
        ? "Approve this pull request and open the next one"
        : "Current pull request is not in the review queue";
      nextBtn.title = enabled
        ? "Next in review queue (Alt+Shift+N)"
        : "Queue clear";
    } catch {
      nextBtn.disabled = true;
      approveNextBtn.disabled = true;
      nextBtn.title = "Queue clear";
      approveNextBtn.title = "Review queue unavailable";
    }
  }

  function setLoading(on, label = "Loading…") {
    loading = on;
    nextBtn.disabled = on;
    approveNextBtn.disabled = on;
    if (on) approveNextBtn.textContent = label;
    else approveNextBtn.textContent = "Approve and Next PR";
  }

  async function goNext() {
    if (nextBtn.disabled || loading) return;
    setLoading(true);
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
      setLoading(false);
      nextBtn.textContent = "Next PR";
      await syncNextButton();
    }
  }

  async function approveAndNext() {
    if (approveNextBtn.disabled || loading) return;
    setLoading(true, "Approving…");
    try {
      const res = await send({
        type: "APPROVE_AND_NEXT",
        currentUrl: location.href,
      });
      if (!res.ok) {
        showToast(res.error || "Approval failed");
        return;
      }
      currentApproved = true;
      if (res.next?.url) {
        location.href = res.next.url;
        return;
      }
      showToast("Approved · Queue clear");
    } finally {
      setLoading(false);
      await syncNextButton();
    }
  }

  nextBtn.addEventListener("click", () => goNext());
  approveNextBtn.addEventListener("click", () => approveAndNext());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[QUEUE_ITEMS_KEY]) return;
    void syncNextButton();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TOAST" && msg.text) showToast(msg.text);
  });

  void syncNextButton();
})();
