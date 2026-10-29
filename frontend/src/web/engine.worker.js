// The web app's engine: runs the real backend (FastAPI + SQLite + the statement parsers) in Pyodide,
// so every page, import and edit behaves exactly as on the PC. It never contacts any other site:
// the page fetches statements from Google Drive and hands them over.
import { SnapshotError, openSnapshot, snapshotSealer } from "./snapshot";

// The backend's own source files, bundled as text and written into Pyodide's file system.
const BACKEND_FILES = import.meta.glob("../../../backend/**/*.py", { query: "?raw", import: "default", eager: true });
const PYODIDE_VERSION = __PYODIDE_VERSION__;
const PACKAGES = __PYODIDE_PACKAGES__; // from Pyodide's own repository: fastapi, cryptography, pillow…
const EXTRA_WHEELS = __EXTRA_WHEELS__; // pure-Python wheels from PyPI: pdfplumber, pdfminer.six, openpyxl…

// The engine only ever talks to the app itself.
const sameOrigin = (url) => new URL(url, self.location.href).origin === self.location.origin;
const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input;
  return sameOrigin(url) ? realFetch(input, init) : Promise.reject(new TypeError("The engine doesn't contact other sites"));
};
const realOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (...args) {
  if (!sameOrigin(args[1])) throw new TypeError("The engine doesn't contact other sites");
  return realOpen.apply(this, args);
};
for (const api of ["WebSocket", "EventSource", "WebTransport"]) self[api] = undefined;

const DATA_HOME = "/home/pyodide/finance";
const APP_HOME = "/home/pyodide/app";
const BOOT = `
import os, sys, types, asyncio, warnings
warnings.filterwarnings("ignore", category=SyntaxWarning)  # old docstrings with Windows paths
os.environ["FINANCE_HOME"] = "${DATA_HOME}"
sys.path.insert(0, "${APP_HOME}")

class _PcOnly(types.ModuleType):
    """Libraries only the PC has: Windows Credential Manager, and pdfplumber's page renderer."""
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        raise RuntimeError(f"{self.__name__} isn't available in the web app")

for _m in ("keyring", "pypdfium2"):
    sys.modules[_m] = _PcOnly(_m)
sys.modules["pikepdf"] = None  # pdftext falls back to pdfminer's own decryption
_mp = types.ModuleType("python_multipart"); _mp.__version__ = "0.0.20"
sys.modules["python_multipart"] = _mp  # FastAPI checks it's installed; uploads go through Drive instead

# Browsers don't have threads: run FastAPI's sync endpoints inline.
import fastapi.concurrency, fastapi.dependencies.utils, fastapi.routing, starlette.concurrency
async def _inline(func, *args, **kwargs):
    return func(*args, **kwargs)
for _mod in (fastapi.concurrency, fastapi.dependencies.utils, fastapi.routing, starlette.concurrency):
    if hasattr(_mod, "run_in_threadpool"):
        _mod.run_in_threadpool = _inline

from backend import db as _db
_db.init_db()  # a new database, or one from an older version brought up to this schema
from backend.app import app as _app
from backend.config import DB_PATH as _DB_PATH, STATEMENTS_DIR as _STATEMENTS_DIR

async def handle(method, path, query, body):
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
             "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
             "query_string": query.encode(), "client": ("127.0.0.1", 0), "server": ("web", 80),
             "headers": [(b"host", b"web"), (b"content-type", b"application/json")]}
    done = asyncio.Event()
    sent = False
    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body.encode(), "more_body": False}
        await done.wait()
        return {"type": "http.disconnect"}
    status, chunks = 500, []
    async def send(message):
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                done.set()
    await _app(scope, receive, send)
    done.set()
    return [status, b"".join(chunks).decode()]

def statement_files():
    """[path relative to the statements folder, md5] of every file in it."""
    import hashlib
    out = []
    for p in sorted(_STATEMENTS_DIR.rglob("*")):
        if p.is_file():
            out.append([p.relative_to(_STATEMENTS_DIR).as_posix(), hashlib.md5(p.read_bytes()).hexdigest()])
    return out

def export_database():
    """[meta JSON, consistent copy of the database]."""
    import json, sqlite3
    from datetime import datetime
    src = sqlite3.connect(_DB_PATH)
    mem = sqlite3.connect(":memory:")
    try:
        src.backup(mem)
    finally:
        src.close()
    meta = {
        "app": "Finance Master",
        "format": 1,
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "transactions": mem.execute("SELECT count(*) FROM transactions").fetchone()[0],
        "accounts": mem.execute("SELECT count(*) FROM accounts WHERE archived = 0").fetchone()[0],
    }
    data = mem.serialize()
    mem.close()
    return [json.dumps(meta), data]
`;

let py = null;
let seal = null;
const post = (msg, transfer = []) => self.postMessage(msg, transfer);
const statementsPath = (rel) => `${DATA_HOME}/statements/${rel}`;

async function open(id, snapshot, passphrase, base) {
  let meta = null;
  let db = null;
  if (snapshot) {
    ({ meta, db } = await openSnapshot(snapshot, passphrase));
  }
  seal = snapshotSealer(passphrase);
  post({ type: "progress", text: "Starting the engine…" });
  const indexURL = `${base}pyodide/${PYODIDE_VERSION}/`;
  const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  py = await loadPyodide({ indexURL, packageBaseUrl: indexURL, stdout: () => {}, stderr: (s) => console.warn(s) });
  post({ type: "progress", text: "Loading Python packages…" });
  await py.loadPackage([...PACKAGES, ...EXTRA_WHEELS.map((f) => indexURL + f)], { messageCallback: () => {} });
  for (const [file, source] of Object.entries(BACKEND_FILES)) {
    const dest = `${APP_HOME}/${file.replace(/^(\.\.\/)+/, "")}`;
    py.FS.mkdirTree(dest.slice(0, dest.lastIndexOf("/")));
    py.FS.writeFile(dest, source);
  }
  py.FS.mkdirTree(`${DATA_HOME}/data`);
  py.FS.mkdirTree(`${DATA_HOME}/statements`);
  if (db) py.FS.writeFile(`${DATA_HOME}/data/finance.db`, db);
  post({ type: "progress", text: "Opening your data…" });
  await py.runPythonAsync(BOOT);
  post({ type: "opened", id, meta });
}

async function request(id, method, url, body) {
  if (!py) throw new Error("The engine isn't running");
  const [path, query = ""] = url.split("?");
  const result = await py.globals.get("handle")(method, path, query, body);
  const [status, text] = result.toJs();
  result.destroy();
  post({ type: "response", id, status, text });
}

function writeFiles(id, files) {
  for (const { path, bytes } of files) {
    const dest = statementsPath(path);
    py.FS.mkdirTree(dest.slice(0, dest.lastIndexOf("/")));
    py.FS.writeFile(dest, new Uint8Array(bytes));
  }
  post({ type: "done", id });
}

function listFiles(id) {
  const result = py.globals.get("statement_files")();
  const files = result.toJs();
  result.destroy();
  post({ type: "files", id, files });
}

function readFile(id, path) {
  const bytes = py.FS.readFile(statementsPath(path)).slice().buffer;
  post({ type: "file", id, bytes }, [bytes]);
}

async function sealDatabase(id) {
  const result = py.globals.get("export_database")();
  const [metaJson, db] = result.toJs();
  result.destroy();
  const meta = JSON.parse(metaJson);
  const bytes = await seal(db, meta);
  post({ type: "sealed", id, bytes, meta }, [bytes]);
}

self.onmessage = (event) => {
  const msg = event.data;
  const run = {
    open: () => open(msg.id, msg.snapshot, msg.passphrase, msg.base),
    request: () => request(msg.id, msg.method, msg.url, msg.body ?? ""),
    writeFiles: () => writeFiles(msg.id, msg.files),
    listFiles: () => listFiles(msg.id),
    readFile: () => readFile(msg.id, msg.path),
    seal: () => sealDatabase(msg.id),
  }[msg.type];
  Promise.resolve()
    .then(run)
    .catch((e) =>
      post({
        type: "error",
        id: msg.id,
        code: e instanceof SnapshotError ? e.code : "engine",
        message: e instanceof Error ? e.message : String(e),
      }),
    );
};
