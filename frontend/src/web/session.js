// One open session of the web app: your Drive folder ⇄ the engine running the backend.
//
// - Statement files live in the Drive folder (subfolders: a family member's name, a month). Each device
//   downloads a file once (cached by its md5) and hands it to the engine; the backend imports it as on the PC.
// - The backend files uploads under the month they cover, moves files into a person's folder and moves deleted
//   ones to _deleted/. After every change those moves and new files are mirrored back to Drive. Nothing in
//   Drive is ever erased.
// - The database is saved, encrypted with your passphrase, as finance-snapshot.fmsnap in the same folder.
//   Before saving, the app checks that no other device saved in between; if one did, it asks you to reload
//   instead of overwriting.
import * as drive from "./drive";
import * as engine from "./engine";
import { CONFLICT, OFFLINE } from "../api";
import { SNAPSHOT_NAME, cacheFile, cachedFile, keepSnapshot, savedSnapshot } from "./snapshot";

const STATEMENT = /\.(pdf|csv|xlsx|xls)$/i;
const SIGN_IN = "Google sign-in expired. Reconnect to save your changes.";

let s = null;
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(patch) {
  s.status = { ...s.status, ...patch };
  listeners.forEach((fn) => fn(s.status));
}

export const status = () => s?.status ?? null;

const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const statementsIn = (tree) => [...tree.files.values()].filter((f) => f.md5Checksum && STATEMENT.test(f.name));

/** Is there a saved database in this folder? */
export async function hasSnapshot(folderId) {
  return Boolean(await drive.findChild(folderId, SNAPSHOT_NAME));
}

/**
 * Open the folder: load the database (or start a new one), bring in any new statements and import them.
 * With offline, open the copy this device saved last time, view-only.
 */
export async function openSession({ folderId, passphrase, progress, offline = false }) {
  s = {
    folderId,
    files: new Map(), // path → Drive file, for every statement file
    folders: new Map(), // dir path → Drive folder id
    snapshot: null, // the Drive file holding the database
    timer: null,
    chain: Promise.resolve(),
    status: { offline, saving: false, dirty: false, conflict: false, needsSignIn: false, error: null, lastSync: null, lastSave: null },
  };
  if (offline) {
    const saved = await savedSnapshot(folderId);
    if (!saved) throw new Error("There's no copy of your data on this device yet.");
    const meta = await engine.startEngine(saved.bytes, passphrase, progress);
    return { meta, scan: null };
  }

  progress("Reading your Drive folder…");
  const tree = await drive.listTree(folderId);
  s.folders = tree.folders;
  s.snapshot = tree.files.get(SNAPSHOT_NAME) ?? null;
  let bytes = null;
  if (s.snapshot) {
    progress("Downloading your data…");
    bytes = await drive.download(s.snapshot.id);
  }
  const meta = await engine.startEngine(bytes, passphrase, progress); // a wrong passphrase stops here
  if (bytes) await keepSnapshot(folderId, { bytes, meta, savedAt: new Date().toISOString() });
  const statements = statementsIn(tree);
  s.files = new Map(statements.map((f) => [f.path, f]));
  await loadFiles(statements, progress);
  progress("Importing new statements…");
  const scan = await engine.engineRequest("POST", "/scan");
  emit({ lastSync: Date.now() });
  if (!s.snapshot || scan.new) changed({ now: true }); // a new database is saved straight away
  return { meta, scan };
}

/** Give the engine these Drive files, downloading the ones this device hasn't seen. */
async function loadFiles(files, progress) {
  const out = [];
  const missing = [];
  for (const f of files) {
    const bytes = await cachedFile(f.md5Checksum);
    if (bytes) out.push({ path: f.path, bytes });
    else missing.push(f);
  }
  let n = 0;
  for (const f of missing) {
    progress?.(`Downloading statements… ${++n} of ${missing.length}`);
    const bytes = await drive.download(f.id);
    await cacheFile(f.md5Checksum, bytes);
    out.push({ path: f.path, bytes });
  }
  if (out.length) await engine.writeFiles(out);
}

/** Look for new statements in Drive and import them (the Rescan button, and whenever the app comes back into view). */
export async function syncNow() {
  guard();
  await s.chain;
  const tree = await drive.listTree(s.folderId);
  s.folders = tree.folders;
  const remote = tree.files.get(SNAPSHOT_NAME);
  if ((remote?.version ?? null) !== (s.snapshot?.version ?? null)) {
    emit({ conflict: true });
    throw new Error(CONFLICT);
  }
  const statements = statementsIn(tree);
  const fresh = statements.filter((f) => s.files.get(f.path)?.md5Checksum !== f.md5Checksum);
  for (const f of statements) s.files.set(f.path, f);
  await loadFiles(fresh);
  const scan = await engine.engineRequest("POST", "/scan");
  emit({ lastSync: Date.now() });
  if (scan.new || fresh.length) changed();
  return scan;
}

function guard() {
  if (!s) throw new Error("Locked");
  if (s.status.offline) throw new Error(OFFLINE);
  if (s.status.conflict) throw new Error(CONFLICT);
}

/** Every /api call of the web app. */
export async function request(method, path, body) {
  if (method === "GET") return engine.engineRequest(method, path);
  guard();
  if (method === "POST" && path === "/scan") return syncNow();
  const result = await engine.engineRequest(method, path, body);
  changed();
  return result;
}

/** Statement files picked or dropped in the app: into the engine, then the backend files and imports them. */
export async function upload(path, files) {
  guard();
  const memberId = new URLSearchParams(path.split("?")[1] ?? "").get("member_id");
  let folder = null;
  if (memberId) {
    const { members } = await engine.engineRequest("GET", "/members");
    folder = members.find((m) => String(m.id) === memberId)?.folder ?? null;
  }
  const now = new Date();
  const dir = [folder, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`].filter(Boolean).join("/");
  const taken = new Set((await engine.listFiles()).map(([p]) => p));
  const out = [];
  for (const file of files) {
    if (!STATEMENT.test(file.name)) continue;
    const name = basename(file.name);
    const dot = name.lastIndexOf(".");
    let dest = `${dir}/${name}`;
    for (let i = 1; taken.has(dest); i++) dest = `${dir}/${name.slice(0, dot)} (${i})${name.slice(dot)}`;
    taken.add(dest);
    out.push({ path: dest, bytes: await file.arrayBuffer() });
  }
  if (out.length) await engine.writeFiles(out);
  const scan = await engine.engineRequest("POST", "/scan");
  changed({ now: true });
  return { saved: out.map((f) => `statements/${f.path}`), ...scan };
}

// ---------------------------------------------------------------- saving to Drive

function changed({ now = false } = {}) {
  emit({ dirty: true });
  clearTimeout(s.timer);
  s.timer = setTimeout(() => queue(persist), now ? 0 : 2000); // edits often come in bursts
}

function queue(fn) {
  const session = s;
  session.chain = session.chain.then(fn).catch((e) => {
    if (session !== s) return;
    if (e instanceof drive.DriveAuthError) emit({ saving: false, needsSignIn: true, error: SIGN_IN });
    else emit({ saving: false, error: e.message });
  });
  return session.chain;
}

async function persist() {
  if (!s.status.dirty || s.status.conflict) return;
  emit({ saving: true });
  await mirror();
  await save();
  emit({ saving: false, dirty: false, error: null, needsSignIn: false, lastSave: Date.now() });
}

async function ensureFolder(dir) {
  if (s.folders.has(dir)) return s.folders.get(dir);
  const parent = await ensureFolder(dirname(dir));
  const f = await drive.createFolder(basename(dir), parent);
  s.folders.set(dir, f.id);
  return f.id;
}

/** Make Drive match the engine's statements folder: moved files are moved, new ones uploaded. */
async function mirror() {
  const local = await engine.listFiles();
  const here = new Set(local.map(([p]) => p));
  const gone = new Map(); // md5 → Drive files whose path no longer exists locally (moved away)
  for (const f of s.files.values()) {
    if (!here.has(f.path)) gone.set(f.md5Checksum, [...(gone.get(f.md5Checksum) ?? []), f]);
  }
  for (const [path, md5] of local) {
    if (s.files.has(path)) continue;
    const parent = await ensureFolder(dirname(path));
    const moved = gone.get(md5)?.shift();
    let f;
    if (moved) {
      f = await drive.moveFile(moved.id, basename(path), parent, s.folders.get(dirname(moved.path)) ?? moved.parents?.[0]);
      s.files.delete(moved.path);
    } else {
      const bytes = await engine.readFile(path);
      f = await drive.createFile(basename(path), parent, bytes);
      await cacheFile(f.md5Checksum, bytes);
    }
    s.files.set(path, { ...f, path });
  }
}

async function save() {
  if (s.snapshot) {
    const remote = await drive.getMeta(s.snapshot.id);
    if (remote.version !== s.snapshot.version) {
      emit({ conflict: true });
      throw new Error(CONFLICT);
    }
  }
  const { bytes, meta } = await engine.sealDatabase();
  s.snapshot = s.snapshot ? await drive.updateFile(s.snapshot.id, bytes) : await drive.createFile(SNAPSHOT_NAME, s.folders.get(""), bytes);
  await keepSnapshot(s.folderId, { bytes, meta, savedAt: new Date().toISOString() });
}

/** Save anything pending now (Retry, and before locking). */
export async function flush() {
  if (!s) return;
  clearTimeout(s.timer);
  if (s.status.dirty && !s.status.offline) await queue(persist);
  await s.chain;
}

export async function reconnect() {
  await drive.signIn();
  emit({ needsSignIn: false, error: null });
  if (s.status.dirty) await queue(persist);
}

export async function closeSession() {
  try {
    await flush();
  } catch {}
  engine.stopEngine();
  s = null;
}
