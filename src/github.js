/**
 * GitHub API helpers shared by service worker + options page.
 * @typedef {{
 *   id: number,
 *   title: string,
 *   url: string,
 *   repo: string,
 *   number: number,
 *   updatedAt: string,
 * }} QueueItem
 */

/**
 * @param {string} token
 * @param {string} path
 * @param {Record<string, string>} [query]
 * @param {{ onDebug?: (...args: unknown[]) => void }} [opts]
 */
export async function ghFetch(token, path, query = {}, { onDebug } = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const safeUrl = url.toString();
  onDebug?.("request", {
    method: "GET",
    url: safeUrl,
    path,
    query: { ...query },
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer ***",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const bodyText = await res.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = bodyText;
  }
  const headers = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  onDebug?.("response", {
    status: res.status,
    ok: res.ok,
    url: safeUrl,
    headers,
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  if (typeof body === "string") {
    throw new Error(`GitHub ${res.status}: invalid JSON`);
  }
  return body;
}

/**
 * @param {string} token
 * @param {string[]} repos
 * @param {{ onDebug?: (...args: unknown[]) => void }} [opts]
 * @returns {Promise<QueueItem[]>}
 */
export async function fetchReviewQueue(token, repos, { onDebug } = {}) {
  if (!token) throw new Error("Set a GitHub PAT in extension options.");
  if (!repos.length)
    throw new Error("Add at least one repo in extension options.");

  const repoQ = repos.map((r) => `repo:${r}`).join(" ");
  const q = `is:pr is:open review-requested:@me draft:false ${repoQ}`;
  onDebug?.("fetchReviewQueue", { repos, q });

  /** @type {QueueItem[]} */
  const items = [];
  for (let page = 1; page <= 3; page += 1) {
    const data = await ghFetch(
      token,
      "/search/issues",
      {
        q,
        sort: "updated",
        order: "asc",
        per_page: "100",
        page: String(page),
      },
      { onDebug },
    );
    for (const issue of data.items || []) {
      const repo = (issue.repository_url || "").replace(
        "https://api.github.com/repos/",
        "",
      );
      items.push({
        id: issue.id,
        title: issue.title,
        url: issue.html_url,
        repo: repo.toLowerCase(),
        number: issue.number,
        updatedAt: issue.updated_at,
      });
    }
    if (!data.items?.length || items.length >= (data.total_count || 0)) break;
  }

  onDebug?.("fetchReviewQueue done", { count: items.length, items });
  return items;
}

/**
 * @param {string} token
 * @param {{ onDebug?: (...args: unknown[]) => void }} [opts]
 * @returns {Promise<string[]>}
 */
export async function fetchUserRepos(token, { onDebug } = {}) {
  /** @type {string[]} */
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await ghFetch(
      token,
      "/user/repos",
      {
        per_page: "100",
        page: String(page),
        affiliation: "owner,collaborator,organization_member",
        sort: "full_name",
      },
      { onDebug },
    );
    if (!Array.isArray(body) || body.length === 0) break;
    for (const repo of body) {
      if (repo?.full_name) {
        out.push(
          String(repo.full_name)
            .trim()
            .replace(/^https?:\/\/github\.com\//i, "")
            .replace(/\.git$/, "")
            .toLowerCase(),
        );
      }
    }
    if (body.length < 100) break;
  }
  return [...new Set(out)].sort();
}
