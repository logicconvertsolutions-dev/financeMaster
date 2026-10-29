import { useEffect, useState } from "react";
import { useApp, useWeb } from "../context";

const ago = (t) => {
  const min = Math.round((Date.now() - t) / 60000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

/** Sidebar footer of the web app: which Drive folder, whether everything is saved, and the folder actions. */
export function WebStatus() {
  const web = useWeb();
  const { bump, toast } = useApp();
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  if (!web) {
    return null;
  }
  const { folder, status, reconnect, retry, reload, lock, changeFolder } = web;
  const syncNow = async () => {
    try {
      const r = await web.syncNow();
      toast(r.new ? `${r.new} new file(s) found · ${r.parsed} imported, ${r.needs_review} need review` : "No new statements in Drive");
      bump();
    } catch (e) {
      toast(e.message);
    }
  };
  const run = (fn) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  let line;
  if (status.offline) {
    line = <span className="phone-stale">Offline copy · view-only</span>;
  } else if (status.conflict) {
    line = (
      <>
        <span className="phone-stale">Another device saved newer data.</span>
        <button className="btn small" onClick={reload}>
          Reload
        </button>
      </>
    );
  } else if (status.needsSignIn) {
    line = (
      <>
        <span className="phone-stale">Not saved: Google sign-in expired.</span>
        <button className="btn small" onClick={run(reconnect)} disabled={busy}>
          Reconnect
        </button>
      </>
    );
  } else if (status.error) {
    line = (
      <>
        <span className="phone-stale" title={status.error}>
          Not saved yet: {status.error}
        </span>
        <button className="btn small" onClick={run(retry)} disabled={busy}>
          Retry
        </button>
      </>
    );
  } else if (status.saving || status.dirty) {
    line = "Saving to Drive…";
  } else {
    line = `Saved to Drive${status.lastSave || status.lastSync ? ` · ${ago(Math.max(status.lastSave ?? 0, status.lastSync ?? 0))}` : ""}`;
  }
  return (
    <>
      <div>
        Drive folder:{" "}
        <a href={`https://drive.google.com/drive/folders/${folder.id}`} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          {folder.name}
        </a>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 2 }}>
        {line}
      </div>
      <div className="phone-actions">
        {!status.offline && (
          <button className="btn small" onClick={run(syncNow)} disabled={busy || status.conflict}>
            {busy ? "Syncing…" : "Sync now"}
          </button>
        )}
        <button className="btn small" onClick={lock}>
          Lock
        </button>
      </div>
      <button className="btn small" style={{ marginTop: 6, width: "100%", background: "none", color: "inherit" }} onClick={changeFolder}>
        Change folder
      </button>
    </>
  );
}
