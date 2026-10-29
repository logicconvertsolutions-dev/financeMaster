import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";

export function ViewingPicker({ members, groups, ids, onChange, onGroupsChanged, go }) {
  const { toast, viewing } = useApp();
  const [l, c] = useState(false);
  const [d, f] = useState("");
  const p = useRef(null);
  useEffect(() => {
    if (!l) {
      return;
    }
    const m = (w) => {
      if (p.current && !p.current.contains(w.target)) {
        c(false);
      }
    };
    const g = (w) => {
      if (w.key === "Escape") {
        c(false);
      }
    };
    document.addEventListener("mousedown", m);
    document.addEventListener("keydown", g);
    return () => {
      document.removeEventListener("mousedown", m);
      document.removeEventListener("keydown", g);
    };
  }, [l]);
  if (members.length < 2) {
    return null;
  }
  const h = new Set(ids ?? members.map((m) => m.id));
  const y = (m) => {
    const g = new Set(h);
    if (g.has(m)) {
      g.delete(m);
    } else {
      g.add(m);
    }
    if (g.size !== 0) {
      onChange(g.size === members.length ? null : [...g]);
    }
  };
  const b = (m, g) => m.length === g.length && m.every((w) => g.includes(w));
  const v = ids && groups.find((m) => b(m.member_ids, ids));
  return (
    <div className="viewing" ref={p}>
      <button className="viewing-btn" onClick={() => c(!l)} aria-expanded={l} aria-haspopup="true">
        <span
          className="small"
          style={{
            opacity: 0.75,
          }}
        >
          Viewing
        </span>
        <span className="viewing-label">{viewing.label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {l && (
        <div className="viewing-panel" role="dialog" aria-label="Choose whose finances to show">
          <button
            className={`viewing-row ${ids === null ? "on" : ""}`}
            onClick={() => {
              onChange(null);
              c(false);
            }}
          >
            <span
              className="swatch"
              style={{
                background: "var(--accent)",
              }}
            />{" "}
            Everyone
          </button>
          <div className="viewing-sep" />
          {members.map((m) => (
            <label className="viewing-row" key={m.id}>
              <input type="checkbox" checked={h.has(m.id)} onChange={() => y(m.id)} />
              <span
                className="swatch"
                style={{
                  background: m.color ?? "var(--other)",
                }}
              />
              <span
                style={{
                  flex: 1,
                }}
              >
                {m.name}
              </span>
              <button
                className="btn small"
                onClick={(g) => {
                  g.preventDefault();
                  onChange([m.id]);
                  c(false);
                }}
              >
                Only
              </button>
            </label>
          ))}
          {groups.length > 0 && <div className="viewing-sep" />}
          {groups.map((m) => (
            <button
              className={`viewing-row ${v?.id === m.id ? "on" : ""}`}
              onClick={() => {
                onChange(m.member_ids.length >= members.length ? null : m.member_ids);
                c(false);
              }}
              key={m.id}
            >
              <span aria-hidden="true">👥</span> {m.name}
              <span
                className="small muted"
                style={{
                  marginLeft: "auto",
                }}
              >
                {m.member_ids.length} people
              </span>
            </button>
          ))}
          {ids && ids.length >= 2 && !v && (
            <form
              className="row"
              style={{
                padding: "8px 10px 4px",
                gap: 6,
              }}
              onSubmit={async (m) => {
                m.preventDefault();
                try {
                  await api.post("/member-groups", {
                    name: d,
                    member_ids: ids,
                  });
                  f("");
                  onGroupsChanged();
                  toast(`Group "${d}" saved`);
                } catch (g) {
                  toast(g.message);
                }
              }}
            >
              <input
                placeholder="Save as group, e.g. Family"
                value={d}
                onChange={(m) => f(m.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                }}
                aria-label="Group name"
              />
              <button className="btn small" disabled={!d.trim()}>
                Save
              </button>
            </form>
          )}
          <div className="viewing-sep" />
          <button
            className="viewing-row small"
            onClick={() => {
              c(false);
              go("accounts");
            }}
          >
            Manage family members…
          </button>
        </div>
      )}
    </div>
  );
}
