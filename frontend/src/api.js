// The phone build answers /api calls from the backend running in its engine worker; the PC build asks the server.
export const IS_PHONE = import.meta.env.MODE === "phone";

export const VIEW_ONLY =
  "The phone app is view-only. Make changes on your PC; they reach your phone with the next snapshot.";

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
  if (IS_PHONE) {
    const { phoneRequest } = await import("./phone/engine");
    return phoneRequest(method, path);
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
  upload: (path, files) => {
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));
    return request("POST", path, form);
  },
};
