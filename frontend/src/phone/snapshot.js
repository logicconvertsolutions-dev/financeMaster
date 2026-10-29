// The locked snapshot the PC writes (backend/snapshot.py has the file layout):
//   b"FMS1" | iterations: uint32 BE | salt: 16 bytes | iv: 12 bytes | AES-256-GCM ciphertext + tag
// The first 36 bytes are the GCM associated data; the plaintext is gzip(meta_len | meta JSON | SQLite bytes).
const MAGIC = "FMS1";

export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isSnapshot(bytes) {
  return bytes.byteLength > 52 && new TextDecoder().decode(new Uint8Array(bytes, 0, 4)) === MAGIC;
}

/** Decrypt a snapshot: {meta, db} where db is the SQLite file. */
export async function openSnapshot(bytes, passphrase) {
  if (!isSnapshot(bytes)) {
    throw new SnapshotError("not-snapshot", "That file isn't a Finance Master snapshot. Pick finance-snapshot.fmsnap.");
  }
  const all = new Uint8Array(bytes);
  const iterations = new DataView(bytes).getUint32(4);
  const header = all.slice(0, 36);
  // NFC so a passphrase typed on the phone's keyboard matches the one typed on the PC
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFC")), "PBKDF2", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: all.slice(8, 24), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(24, 36), additionalData: header }, key, all.slice(36));
  } catch {
    throw new SnapshotError("wrong-passphrase", "Wrong passphrase.");
  }
  try {
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    const metaLen = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
    return { meta: JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + metaLen))), db: raw.slice(4 + metaLen) };
  } catch {
    throw new SnapshotError("damaged", "The snapshot file is damaged. Update it on the PC and pick it again.");
  }
}

// ---------------------------------------------------------------- the copy kept on the phone (IndexedDB)

const DB_NAME = "finance-master-phone";
const STORE = "snapshot";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export const loadSaved = () => withStore("readonly", (s) => s.get("current")).catch(() => {});

export const saveSnapshot = (snap) => withStore("readwrite", (s) => s.put(snap, "current"));

export const removeSaved = () => withStore("readwrite", (s) => s.delete("current"));
