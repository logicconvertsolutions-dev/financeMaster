import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "../App";
import { PhoneContext } from "../context";
import { startEngine, stopEngine } from "./engine";
import { isSnapshot, loadSaved, removeSaved, saveSnapshot } from "./snapshot";

const LOCK_AFTER_MS = 300000;

export function PhoneGate() {
  const [e, t] = useState({
    step: "boot",
  });
  const [n, r] = useState("");
  const a = useRef(null);
  useEffect(() => {
    loadSaved().then((d) =>
      t(
        d
          ? {
              step: "locked",
              snap: d,
            }
          : {
              step: "choose",
            },
      ),
    );
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }, []);
  const i = useCallback(() => {
    stopEngine();
    r("");
    t((d) =>
      "snap" in d
        ? {
            step: "locked",
            snap: d.snap,
          }
        : {
            step: "choose",
          },
    );
  }, []);
  useEffect(() => {
    if (e.step !== "ready") {
      return;
    }
    let d = 0;
    const f = () => {
      if (document.hidden) {
        d = Date.now();
      } else if (d && Date.now() - d > LOCK_AFTER_MS) {
        i();
      }
    };
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, [e.step, i]);
  const o = async (d) => {
    var h;
    var y;
    if (!d) {
      return;
    }
    const f = await d.arrayBuffer();
    if (!isSnapshot(f)) {
      t((b) =>
        "snap" in b
          ? {
              step: "locked",
              snap: b.snap,
              error: `"${d.name}" isn't a Finance Master snapshot. Pick finance-snapshot.fmsnap.`,
            }
          : {
              step: "choose",
              error: `"${d.name}" isn't a Finance Master snapshot. Pick finance-snapshot.fmsnap.`,
            },
      );
      return;
    }
    const p = {
      bytes: f,
      name: d.name,
      savedAt: new Date().toISOString(),
    };
    await saveSnapshot(p).catch(() => {});
    if ((y = (h = navigator.storage) == null ? undefined : h.persist) != null) {
      y.call(h).catch(() => {});
    }
    stopEngine();
    t({
      step: "locked",
      snap: p,
    });
  };
  const u = async (d) => {
    t({
      step: "opening",
      snap: d,
      text: "Unlocking…",
    });
    try {
      const f = await startEngine(d.bytes, n, (p) =>
        t({
          step: "opening",
          snap: d,
          text: p,
        }),
      );
      r("");
      t({
        step: "ready",
        snap: d,
        meta: f,
      });
    } catch (f) {
      stopEngine();
      t({
        step: "locked",
        snap: d,
        error: f.message,
      });
    }
  };
  const l = (
    <input
      ref={a}
      type="file"
      hidden={true}
      onChange={(d) => {
        o(d.target.files?.[0]);
        d.target.value = "";
      }}
    />
  );
  const c = () => {
    var d;
    if ((d = a.current) == null) {
      return undefined;
    } else {
      return d.click();
    }
  };
  if (e.step === "ready") {
    return (
      <PhoneContext.Provider
        value={{
          meta: e.meta,
          lock: i,
          pickNewer: c,
        }}
      >
        <App />
        {l}
      </PhoneContext.Provider>
    );
  } else {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="brand gate-brand">
            <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="var(--accent)" />
              <path
                d="M8 22l5-6 4 3 7-9"
                stroke="white"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Finance Master
          </div>
          {e.step === "boot" && <p className="muted">Loading…</p>}
          {e.step === "choose" && (
            <>
              <h1>Open your data</h1>
              <p className="sub">
                Your PC saves a locked copy of your finances. Pick it here to view it on this phone.
              </p>
              <ol className="gate-steps">
                <li>
                  On your PC, open <b>Categories & settings → Your data → Phone app</b> and choose your Google Drive
                  folder and a passphrase.
                </li>
                <li>
                  Tap below, then <b>Browse → Google Drive → Finance Master</b>, and pick <b>finance-snapshot.fmsnap</b>
                  .
                </li>
              </ol>
              {e.error && (
                <p className="gate-error" role="alert">
                  {e.error}
                </p>
              )}
              <button className="btn primary gate-btn" onClick={c}>
                Choose snapshot file
              </button>
            </>
          )}
          {(e.step === "locked" || e.step === "opening") && (
            <form
              onSubmit={(d) => {
                d.preventDefault();
                if (e.step === "locked") {
                  u(e.snap);
                }
              }}
            >
              <h1>Unlock</h1>
              <p className="sub">Enter the passphrase you chose on your PC.</p>
              <input
                className="gate-input"
                type="password"
                value={n}
                onChange={(d) => r(d.target.value)}
                autoComplete="current-password"
                aria-label="Passphrase"
                placeholder="Passphrase"
                autoFocus={true}
                disabled={e.step === "opening"}
              />
              {e.step === "locked" && e.error && (
                <p className="gate-error" role="alert">
                  {e.error}
                </p>
              )}
              <button className="btn primary gate-btn" disabled={!n || e.step === "opening"}>
                {e.step === "opening" ? e.text : "Unlock"}
              </button>
              {e.step === "opening" && (
                <p
                  className="small muted"
                  style={{
                    textAlign: "center",
                  }}
                >
                  The first time takes a little longer (about 16 MB to set up, then it works offline).
                </p>
              )}
              {e.step === "locked" && (
                <div className="gate-links">
                  <span className="small muted">File added {new Date(e.snap.savedAt).toLocaleString()}</span>
                  <button type="button" className="btn" onClick={c}>
                    Pick a newer file
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={async () => {
                      if (window.confirm("Remove your data from this phone? You can pick the file again anytime.")) {
                        await removeSaved().catch(() => {});
                        r("");
                        t({
                          step: "choose",
                        });
                      }
                    }}
                  >
                    Remove from this phone
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
        <p className="small muted gate-foot">
          Private: your data is unlocked only on this phone and never sent anywhere.
        </p>
        {l}
      </div>
    );
  }
}
