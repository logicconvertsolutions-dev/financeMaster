// The page's side of the engine worker: one promise per message.
let worker = null;
let nextId = 1;
const pending = new Map();
let onProgress = () => {};

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./engine.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "progress") return onProgress(msg.text);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "error") p.reject(Object.assign(new Error(msg.message), { code: msg.code }));
    else p.resolve(msg);
  };
  worker.onerror = (event) => {
    const e = new Error(event.message || "The engine stopped");
    pending.forEach((p) => p.reject(e));
    pending.clear();
  };
  return worker;
}

function call(msg, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

/** Start the engine on a snapshot (ArrayBuffer) or, with null, on a new empty database. */
export async function startEngine(snapshot, passphrase, progress) {
  stopEngine();
  onProgress = progress;
  const copy = snapshot ? snapshot.slice(0) : null;
  const base = new URL("./", window.location.href).href;
  return (await call({ type: "open", snapshot: copy, passphrase, base }, copy ? [copy] : [])).meta;
}

export function stopEngine() {
  worker?.terminate();
  worker = null;
  pending.forEach((p) => p.reject(new Error("Locked")));
  pending.clear();
}

/** An /api request answered by the backend inside the engine. */
export async function engineRequest(method, path, body) {
  const res = await call({ type: "request", method, url: `/api${path}`, body: body === undefined ? "" : JSON.stringify(body) });
  let data = null;
  try {
    data = JSON.parse(res.text);
  } catch {}
  if (res.status >= 400) {
    const detail = data?.detail;
    throw new Error(typeof detail === "string" ? detail : res.status === 404 ? "Not Found" : `Error ${res.status}`);
  }
  return data;
}

/** files: [{path (relative to the statements folder), bytes}] */
export const writeFiles = (files) => call({ type: "writeFiles", files });
/** [[path, md5], …] of everything in the statements folder. */
export const listFiles = async () => (await call({ type: "listFiles" })).files;
export const readFile = async (path) => (await call({ type: "readFile", path })).bytes;
/** The database, encrypted: {bytes, meta}. */
export const sealDatabase = async () => {
  const { bytes, meta } = await call({ type: "seal" });
  return { bytes, meta };
};
