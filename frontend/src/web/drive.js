// Google Drive, from the browser: sign-in with Google Identity Services and the few Drive v3 calls the app needs.
// Paths are relative to the statements folder you picked, e.g. "Sam/2026-09/visa.pdf".
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
const API = import.meta.env.VITE_DRIVE_API || "https://www.googleapis.com";
const TEST_TOKEN = import.meta.env.VITE_TEST_GOOGLE_TOKEN; // local tests against a fake Drive only
const SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,md5Checksum,version,parents";

export const driveConfigured = () => Boolean(CLIENT_ID || TEST_TOKEN);

export class DriveAuthError extends Error {}

let token = null; // {value, expires}
let tokenClient = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load Google sign-in. Are you online?"));
    document.head.appendChild(s);
  });
}

/** Sign in (opens Google's popup: call it from a click). */
export async function signIn() {
  if (TEST_TOKEN) {
    token = { value: TEST_TOKEN, expires: Infinity };
    return;
  }
  await loadGis();
  await new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = { value: r.access_token, expires: Date.now() + (r.expires_in - 60) * 1000 };
        resolve();
      },
      error_callback: (e) => reject(new Error(e.message || "Sign-in was cancelled")),
    });
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

export const signedIn = () => Boolean(token && token.expires > Date.now());

async function drive(path, { method = "GET", query = {}, body, headers = {}, raw = false } = {}) {
  if (!signedIn()) throw new DriveAuthError("Google sign-in expired");
  const url = new URL(API + path);
  for (const [k, v] of Object.entries({ supportsAllDrives: "true", ...query })) url.searchParams.set(k, v);
  const res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${token.value}`, ...headers } });
  if (res.status === 401) {
    token = null;
    throw new DriveAuthError("Google sign-in expired");
  }
  if (!res.ok) {
    let msg = `Google Drive error ${res.status}`;
    try {
      msg = (await res.json()).error?.message ?? msg;
    } catch {}
    throw new Error(msg);
  }
  return raw ? res.arrayBuffer() : res.json();
}

/** The folder id in a Drive link (…/folders/<id>, ?id=<id>), or the id itself. */
export function folderIdFromLink(link) {
  const s = link.trim();
  const m = s.match(/\/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : null;
}

export async function getFolder(id) {
  const f = await drive(`/drive/v3/files/${id}`, { query: { fields: FIELDS } });
  if (f.mimeType !== FOLDER) throw new Error("That link is a file, not a folder.");
  return f;
}

async function children(folderId) {
  const out = [];
  let pageToken;
  do {
    const r = await drive("/drive/v3/files", {
      query: {
        q: `'${folderId}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: "1000",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      },
    });
    out.push(...r.files);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

/** The file called `name` directly in the folder, or null. */
export async function findChild(folderId, name) {
  const r = await drive("/drive/v3/files", {
    query: {
      q: `'${folderId}' in parents and name = '${name.replace(/[\\']/g, "\\$&")}' and trashed = false`,
      fields: `files(${FIELDS})`,
      includeItemsFromAllDrives: "true",
    },
  });
  return r.files[0] ?? null;
}

/** Every file under the folder: {files: Map(path → file), folders: Map(dir path → id, "" = the folder itself)}. */
export async function listTree(rootId) {
  const files = new Map();
  const folders = new Map([["", rootId]]);
  const queue = [""];
  while (queue.length) {
    const dir = queue.shift();
    for (const f of await children(folders.get(dir))) {
      const path = dir ? `${dir}/${f.name}` : f.name;
      if (f.mimeType === FOLDER) {
        folders.set(path, f.id);
        queue.push(path);
      } else if (!files.has(path)) {
        files.set(path, { ...f, path });
      }
    }
  }
  return { files, folders };
}

export const download = (id) => drive(`/drive/v3/files/${id}`, { query: { alt: "media" }, raw: true });

export const getMeta = (id) => drive(`/drive/v3/files/${id}`, { query: { fields: FIELDS } });

export const createFolder = (name, parentId) =>
  drive("/drive/v3/files", {
    method: "POST",
    query: { fields: FIELDS },
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
  });

export function createFile(name, parentId, bytes) {
  const boundary = `fm${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name, parents: [parentId] }),
    `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  return drive("/upload/drive/v3/files", {
    method: "POST",
    query: { uploadType: "multipart", fields: FIELDS },
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

export const updateFile = (id, bytes) =>
  drive(`/upload/drive/v3/files/${id}`, {
    method: "PATCH",
    query: { uploadType: "media", fields: FIELDS },
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });

export const moveFile = (id, name, toParent, fromParent) =>
  drive(`/drive/v3/files/${id}`, {
    method: "PATCH",
    query: { fields: FIELDS, ...(toParent !== fromParent ? { addParents: toParent, removeParents: fromParent } : {}) },
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
