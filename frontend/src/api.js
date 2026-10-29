// The web build (Vercel) answers /api calls from the backend running in its engine worker, synced with your
// Google Drive folder; the PC build asks the local server (run.py).
export const IS_WEB = import.meta.env.MODE === "web";

// Why the web app can't save a change right now (shown as a toast, see App.jsx).
export const OFFLINE = "You're viewing the copy saved on this device. Connect to Google Drive to make changes.";
export const CONFLICT = "Another device saved newer data. Reload to continue.";

let scopeIds = null;

/** Limit every GET to these family members (null = everyone). */
export function setScope(ids) {
  scopeIds = ids && ids.length ? [...ids].sort((a, b) => a - b) : null;
}

function withScope(path) {
  if (scopeIds) {
    return `${path}${path.includes("?") ? "&" : "?"}members=${scopeIds.join(",")}`;
  } else {
    return path;
  }
}

async function request(method, path, body) {
  if (method === "GET") {
    path = withScope(path);
  }
  if (IS_WEB) {
    const session = await import("./web/session");
    return session.request(method, path, body);
  }
  const init = { method };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`/api${path}`, init);
  let data = null;
  try {
    data = await r.json();
  } catch {}
  if (!r.ok) {
    const detail = data?.detail;
    throw new Error(typeof detail === "string" ? detail : r.status === 404 ? "Not Found" : `Error ${r.status}`);
  }
  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  patch: (path, body) => request("PATCH", path, body),
  del: (path) => request("DELETE", path),
  upload: async (path, files) => {
    if (IS_WEB) {
      const session = await import("./web/session");
      return session.upload(path, files);
    }
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));
    return request("POST", path, form);
  },
};
