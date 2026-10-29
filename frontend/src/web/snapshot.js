// The encrypted database file, finance-snapshot.fmsnap (backend/snapshot.py has the same format):
//   b"FMS1" | iterations: uint32 BE | salt: 16 bytes | iv: 12 bytes | AES-256-GCM ciphertext + tag
// The first 36 bytes are the GCM associated data; the plaintext is gzip(meta_len | meta JSON | SQLite bytes).
// The PC app (run.py, tools/snapshot_to_db.py) reads and writes the same file.
const MAGIC = "FMS1";
export const SNAPSHOT_NAME = "finance-snapshot.fmsnap";
const ITERATIONS = 600_000;

export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isSnapshot(bytes) {
  return bytes.byteLength > 52 && new TextDecoder().decode(new Uint8Array(bytes, 0, 4)) === MAGIC;
}

async function deriveKey(passphrase, salt, iterations, usage) {
  // NFC so a passphrase typed on a phone keyboard matches the one typed on a PC
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFC")), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Decrypt a snapshot: {meta, db} where db is the SQLite file. */
export async function openSnapshot(bytes, passphrase) {
  if (!isSnapshot(bytes)) {
    throw new SnapshotError("not-snapshot", "That file isn't a Finance Master snapshot.");
  }
  const all = new Uint8Array(bytes);
  const iterations = new DataView(bytes).getUint32(4);
  const key = await deriveKey(passphrase, all.slice(8, 24), iterations, "decrypt");
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(24, 36), additionalData: all.slice(0, 36) }, key, all.slice(36));
  } catch {
    throw new SnapshotError("wrong-passphrase", "Wrong passphrase.");
  }
  try {
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    const metaLen = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
    return { meta: JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + metaLen))), db: raw.slice(4 + metaLen) };
  } catch {
    throw new SnapshotError("damaged", "The snapshot file is damaged.");
  }
}

/**
 * A sealer for one passphrase: derives the key once (600k PBKDF2 rounds are slow on a phone),
 * then every seal uses a fresh random IV.
 */
export function snapshotSealer(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = deriveKey(passphrase, salt, ITERATIONS, "encrypt");
  return async function seal(db, meta) {
    const m = new TextEncoder().encode(JSON.stringify(meta));
    const raw = new Uint8Array(4 + m.length + db.length);
    new DataView(raw.buffer).setUint32(0, m.length);
    raw.set(m, 4);
    raw.set(db, 4 + m.length);
    const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = new Uint8Array(36);
    header.set(new TextEncoder().encode(MAGIC));
    new DataView(header.buffer).setUint32(4, ITERATIONS);
    header.set(salt, 8);
    header.set(iv, 24);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, await key, gz));
    const out = new Uint8Array(36 + ct.length);
    out.set(header);
    out.set(ct, 36);
    return out.buffer;
  };
}

// ---------------------------------------------------------------- what this browser keeps (IndexedDB)
// "files": statement files by Drive md5, so a statement is downloaded once per device.
// "state": the last saved snapshot, to open offline.

const DB_NAME = "finance-master-web";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("files");
      req.result.createObjectStore("state");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export const cachedFile = (md5) => withStore("files", "readonly", (s) => s.get(md5)).catch(() => undefined);
export const cacheFile = (md5, bytes) => withStore("files", "readwrite", (s) => s.put(bytes, md5)).catch(() => {});
export const savedSnapshot = (folderId) => withStore("state", "readonly", (s) => s.get(`snapshot:${folderId}`)).catch(() => undefined);
export const keepSnapshot = (folderId, snap) => withStore("state", "readwrite", (s) => s.put(snap, `snapshot:${folderId}`)).catch(() => {});
export const forgetDevice = () =>
  Promise.all(["files", "state"].map((store) => withStore(store, "readwrite", (s) => s.clear()))).catch(() => {});
