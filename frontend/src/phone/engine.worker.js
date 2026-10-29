// The phone app's engine: decrypts the snapshot and runs the real backend (FastAPI + SQLite) in Pyodide,
// so every page shows exactly the figures the PC shows. Nothing leaves the phone.
import { SnapshotError, openSnapshot } from "./snapshot";

// The backend's own source files, bundled as text and written into Pyodide's file system.
const BACKEND_FILES = import.meta.glob("../../../backend/**/*.py", { query: "?raw", import: "default", eager: true });
const PYODIDE_VERSION = __PYODIDE_VERSION__;

// The app only ever talks to itself: refuse any request to another site from inside the engine.
const sameOrigin = (url) => new URL(url, self.location.href).origin === self.location.origin;
const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input;
  return sameOrigin(url) ? realFetch(input, init) : Promise.reject(new TypeError("The phone app doesn't contact other sites"));
};
const realOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (...args) {
  if (!sameOrigin(args[1])) throw new TypeError("The phone app doesn't contact other sites");
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
    """Libraries only the PC needs (reading PDFs/spreadsheets, Windows Credential Manager)."""
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        raise RuntimeError(f"{self.__name__} isn't available in the phone app")

for _m in ("pikepdf", "pdfplumber", "keyring", "openpyxl", "xlrd"):
    sys.modules[_m] = _PcOnly(_m)
_mp = types.ModuleType("python_multipart"); _mp.__version__ = "0.0.20"
sys.modules["python_multipart"] = _mp  # FastAPI checks it's installed; the phone never uploads

# Browsers don't have threads: run FastAPI's sync endpoints inline.
import fastapi.concurrency, fastapi.dependencies.utils, fastapi.routing, starlette.concurrency
async def _inline(func, *args, **kwargs):
    return func(*args, **kwargs)
for _mod in (fastapi.concurrency, fastapi.dependencies.utils, fastapi.routing, starlette.concurrency):
    if hasattr(_mod, "run_in_threadpool"):
        _mod.run_in_threadpool = _inline

from backend import db as _db
_db.init_db()  # brings a snapshot from an older PC version up to this schema (in memory only)
from backend.app import app as _app

async def handle(method, path, query, body):
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
             "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
             "query_string": query.encode(), "client": ("127.0.0.1", 0), "server": ("phone", 80),
             "headers": [(b"host", b"phone"), (b"content-type", b"application/json")]}
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
`;

let handle = null;
const post = (msg) => self.postMessage(msg);

async function open(id, bytes, passphrase, base) {
  const { meta, db } = await openSnapshot(bytes, passphrase);
  post({ type: "progress", text: "Starting the engine…" });
  const indexURL = `${base}pyodide/${PYODIDE_VERSION}/`;
  const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  const py = await loadPyodide({ indexURL, packageBaseUrl: indexURL, stdout: () => {}, stderr: (s) => console.warn(s) });
  post({ type: "progress", text: "Loading Python packages…" });
  await py.loadPackage(["fastapi"], { messageCallback: () => {} });
  for (const [file, source] of Object.entries(BACKEND_FILES)) {
    const dest = `${APP_HOME}/${file.replace(/^(\.\.\/)+/, "")}`;
    py.FS.mkdirTree(dest.slice(0, dest.lastIndexOf("/")));
    py.FS.writeFile(dest, source);
  }
  py.FS.mkdirTree(`${DATA_HOME}/data`);
  py.FS.mkdirTree(`${DATA_HOME}/statements`);
  py.FS.writeFile(`${DATA_HOME}/data/finance.db`, db);
  post({ type: "progress", text: "Opening your data…" });
  await py.runPythonAsync(BOOT);
  handle = py.globals.get("handle");
  post({ type: "opened", id, meta });
}

async function request(id, method, url, body) {
  if (!handle) throw new Error("The engine isn't running");
  const [path, query = ""] = url.split("?");
  const result = await handle(method, path, query, body);
  const [status, text] = result.toJs();
  result.destroy();
  post({ type: "response", id, status, text });
}

self.onmessage = (event) => {
  const msg = event.data;
  (msg.type === "open" ? open(msg.id, msg.bytes, msg.passphrase, msg.base) : request(msg.id, msg.method, msg.url, msg.body ?? "")).catch(
    (e) =>
      post({
        type: "error",
        id: msg.id,
        code: e instanceof SnapshotError ? e.code : "engine",
        message: e instanceof Error ? e.message : String(e),
      }),
  );
};
