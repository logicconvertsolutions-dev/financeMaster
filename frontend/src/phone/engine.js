import { VIEW_ONLY } from "../api";

let worker = null;

let nextId = 1;

const pending = new Map();

let onProgress = () => {};

function getWorker() {
  return (
    worker ||
    ((worker = new Worker(new URL("./engine.worker.js", import.meta.url), {
      type: "module",
    })),
    (worker.onmessage = (e) => {
      const t = e.data;
      if (t.type === "progress") {
        return onProgress(t.text);
      }
      const n = pending.get(t.id);
      if (n) {
        pending.delete(t.id);
        if (t.type === "error") {
          n.reject(
            Object.assign(new Error(t.message), {
              code: t.code,
            }),
          );
        } else {
          n.resolve(t);
        }
      }
    }),
    (worker.onerror = (e) => {
      const t = new Error(e.message || "The engine stopped");
      pending.forEach((n) => n.reject(t));
      pending.clear();
    }),
    worker)
  );
}

function call(e, t = []) {
  const n = nextId++;
  return new Promise((r, a) => {
    pending.set(n, {
      resolve: r,
      reject: a,
    });
    getWorker().postMessage(
      {
        ...e,
        id: n,
      },
      t,
    );
  });
}

export async function startEngine(e, t, n) {
  stopEngine();
  onProgress = n;
  const r = e.slice(0);
  const a = new URL("./", window.location.href).href;
  return (
    await call(
      {
        type: "open",
        bytes: r,
        passphrase: t,
        base: a,
      },
      [r],
    )
  ).meta;
}

export function stopEngine() {
  if (worker != null) {
    worker.terminate();
  }
  worker = null;
  pending.forEach((e) => e.reject(new Error("Locked")));
  pending.clear();
}

async function phoneRequest(e, t) {
  if (e !== "GET") {
    throw new Error(VIEW_ONLY);
  }
  const n = await call({
    type: "request",
    method: e,
    url: `/api${t}`,
  });
  let r = null;
  try {
    r = JSON.parse(n.text);
  } catch {}
  if (n.status >= 400) {
    const a = r?.detail;
    throw new Error(typeof a == "string" ? a : n.status === 404 ? "Not Found" : `Error ${n.status}`);
  }
  return r;
}
