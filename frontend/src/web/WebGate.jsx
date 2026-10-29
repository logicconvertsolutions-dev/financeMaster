import { useCallback, useEffect, useState } from "react";
import { App } from "../App";
import { WebContext } from "../context";
import { driveConfigured, folderIdFromLink, getFolder, signIn, signedIn } from "./drive";
import * as session from "./session";
import { forgetDevice, savedSnapshot } from "./snapshot";

const LOCK_AFTER_MS = 300000; // lock when the app has been in the background this long
const MIN_PASSPHRASE = 10; // as backend/snapshot.py
const PREFS = "finance-web";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS) ?? "{}");
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(prefs));
  } catch {}
}

/**
 * The web app: sign in with Google, pick the Drive folder with your statements, unlock with your passphrase.
 * Then the full dashboard runs, synced with that folder.
 */
export function WebGate() {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [step, setStep] = useState({ step: driveConfigured() ? "signin" : "unconfigured" });
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(Boolean(loadPrefs().passphrase));
  const [link, setLink] = useState("");
  const [status, setStatus] = useState(null);
  const [offlineCopy, setOfflineCopy] = useState(null);

  const updatePrefs = (patch) => {
    const next = { ...loadPrefs(), ...patch };
    savePrefs(next);
    setPrefs(next);
    return next;
  };

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    if (prefs.folderId) savedSnapshot(prefs.folderId).then((s) => setOfflineCopy(s ?? null));
  }, [prefs.folderId]);

  useEffect(() => session.subscribe(setStatus), []);

  const open = useCallback(async (folder, pass, { offline = false, isNew = false } = {}) => {
    setStep({ step: "opening", folder, text: offline ? "Opening the copy on this device…" : "Signing in…" });
    try {
      const { scan } = await session.openSession({
        folderId: folder.id,
        passphrase: pass,
        offline,
        progress: (text) => setStep({ step: "opening", folder, text }),
      });
      setStatus(session.status());
      setStep({ step: "ready", folder, scan, toast: scan?.new ? `${scan.new} new statement file(s) found` : null });
    } catch (e) {
      await session.closeSession();
      if (e.code === "wrong-passphrase") updatePrefs({ passphrase: undefined });
      setStep({ step: signedIn() || offline ? "unlock" : "signin", folder, isNew, error: e.message });
    }
  }, []);

  /** After sign-in, or with a folder link: check the folder and go to the passphrase. */
  const chooseFolder = useCallback(
    async (id) => {
      try {
        const f = await getFolder(id);
        const folder = { id: f.id, name: f.name };
        const isNew = !(await session.hasSnapshot(f.id));
        const p = updatePrefs({ folderId: f.id, folderName: f.name });
        if (p.passphrase && !isNew) return open(folder, p.passphrase);
        setStep({ step: "unlock", folder, isNew });
      } catch (e) {
        setStep({ step: "folder", error: e.message });
      }
    },
    [open],
  );

  const lock = useCallback(async () => {
    const folder = step.folder;
    await session.closeSession();
    setPassphrase("");
    setConfirm("");
    setStep(signedIn() ? { step: "unlock", folder, isNew: false } : { step: "signin" });
  }, [step.folder]);

  const changeFolder = useCallback(async () => {
    await session.closeSession();
    updatePrefs({ folderId: undefined, folderName: undefined, passphrase: undefined });
    setPassphrase("");
    setStep(signedIn() ? { step: "folder" } : { step: "signin" });
  }, []);

  const reload = useCallback(() => window.location.reload(), []);

  useEffect(() => {
    if (step.step !== "ready") {
      return;
    }
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        session.flush().catch(() => {}); // the phone may close the app any time from here
      } else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) {
        lock();
      }
    };
    const onLeave = (e) => {
      const s = session.status();
      if (s && (s.dirty || s.saving) && !s.offline) {
        session.flush().catch(() => {});
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [step.step, lock]);

  if (step.step === "ready" && status) {
    const value = {
      folder: step.folder,
      status,
      syncNow: () => session.syncNow(),
      reconnect: () => session.reconnect(),
      retry: () => session.flush(),
      reload,
      lock,
      changeFolder,
      firstToast: step.toast,
    };
    return (
      <WebContext.Provider value={value}>
        <App />
      </WebContext.Provider>
    );
  }

  const submitUnlock = (e) => {
    e.preventDefault();
    if (step.isNew && passphrase !== confirm) {
      return setStep({ ...step, error: "The two passphrases don't match." });
    }
    updatePrefs({ passphrase: remember ? passphrase : undefined });
    open(step.folder, passphrase, { isNew: step.isNew });
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand gate-brand">
          <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--accent)" />
            <path d="M8 22l5-6 4 3 7-9" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Finance Master
        </div>

        {step.step === "unconfigured" && (
          <>
            <h1>Almost there</h1>
            <p className="sub">
              This copy of the app has no Google sign-in set up. Add <code>VITE_GOOGLE_CLIENT_ID</code> to the Vercel project's
              environment variables and deploy again (see README).
            </p>
          </>
        )}

        {step.step === "signin" && (
          <>
            <h1>Your finances, from Google Drive</h1>
            <p className="sub">
              Statements are read from a Google Drive folder you choose. Upload a statement there (from any phone or PC) and it
              shows up here.
            </p>
            {step.error && (
              <p className="gate-error" role="alert">
                {step.error}
              </p>
            )}
            <button
              className="btn primary gate-btn"
              onClick={async () => {
                try {
                  await signIn();
                  if (prefs.folderId) await chooseFolder(prefs.folderId);
                  else setStep({ step: "folder" });
                } catch (e) {
                  setStep({ step: "signin", error: e.message });
                }
              }}
            >
              Continue with Google
            </button>
            {offlineCopy && prefs.folderName && (
              <div className="gate-links">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setStep({ step: "unlock", folder: { id: prefs.folderId, name: prefs.folderName }, offline: true })}
                >
                  Open the copy on this device (offline, view-only)
                </button>
              </div>
            )}
          </>
        )}

        {step.step === "folder" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const id = folderIdFromLink(link);
              if (!id) return setStep({ step: "folder", error: "Paste the link of a Google Drive folder." });
              setStep({ step: "checking" });
              chooseFolder(id);
            }}
          >
            <h1>Your statements folder</h1>
            <p className="sub">In Google Drive, open the folder with your statements, copy its link and paste it here.</p>
            <ol className="gate-steps">
              <li>
                Each family member can have a subfolder with their name, e.g. <b>Sam</b>. Statements in it are theirs.
              </li>
              <li>The app keeps your data in that folder too, as an encrypted file called finance-snapshot.fmsnap.</li>
            </ol>
            <input
              className="gate-input"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/…"
              aria-label="Drive folder link"
              autoFocus
            />
            {step.error && (
              <p className="gate-error" role="alert">
                {step.error}
              </p>
            )}
            <button className="btn primary gate-btn" disabled={!link.trim()}>
              Use this folder
            </button>
          </form>
        )}

        {step.step === "checking" && <p className="muted">Checking the folder…</p>}

        {(step.step === "unlock" || step.step === "opening") && (
          <form
            onSubmit={(e) => {
              if (step.offline) {
                e.preventDefault();
                return open(step.folder, passphrase, { offline: true });
              }
              submitUnlock(e);
            }}
          >
            <h1>{step.isNew ? "Choose a passphrase" : "Unlock"}</h1>
            <p className="sub">
              {step.isNew
                ? `Your data will be saved in "${step.folder.name}", encrypted with this passphrase. Use the same one on every device. At least ${MIN_PASSPHRASE} characters, e.g. four random words.`
                : `Enter the passphrase for "${step.folder.name}".`}
            </p>
            <input
              className="gate-input"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete={step.isNew ? "new-password" : "current-password"}
              aria-label="Passphrase"
              placeholder="Passphrase"
              autoFocus
              disabled={step.step === "opening"}
            />
            {step.isNew && (
              <input
                className="gate-input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                aria-label="Passphrase again"
                placeholder="Passphrase again"
                disabled={step.step === "opening"}
              />
            )}
            {!step.offline && (
              <label className="row small" style={{ gap: 6, marginBottom: 12 }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Remember on this device
              </label>
            )}
            {step.step === "unlock" && step.error && (
              <p className="gate-error" role="alert">
                {step.error}
              </p>
            )}
            <button
              className="btn primary gate-btn"
              disabled={step.step === "opening" || (step.isNew ? passphrase.length < MIN_PASSPHRASE : !passphrase)}
            >
              {step.step === "opening" ? step.text : step.isNew ? "Create" : "Unlock"}
            </button>
            {step.step === "opening" && (
              <p className="small muted" style={{ textAlign: "center" }}>
                The first time takes a little longer (about 25 MB to set up, then it opens quickly).
              </p>
            )}
            {step.step === "unlock" && (
              <div className="gate-links">
                <button type="button" className="btn" onClick={changeFolder}>
                  Use a different folder
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={async () => {
                    if (window.confirm("Remove the saved data and settings from this device? Your Drive folder isn't touched.")) {
                      await forgetDevice();
                      savePrefs({});
                      window.location.reload();
                    }
                  }}
                >
                  Forget this device
                </button>
              </div>
            )}
          </form>
        )}
      </div>
      <p className="small muted gate-foot">
        Private: your statements and data stay in your Google Drive and on your devices. This site has no server that sees them.
      </p>
    </div>
  );
}
