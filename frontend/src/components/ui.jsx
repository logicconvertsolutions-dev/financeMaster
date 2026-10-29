import { useApp } from "../context";
import { money } from "../format";

export function Card({ title, extra, children, className = "", style }) {
  return (
    <section className={`card ${className}`} style={style}>
      {(title || extra) && (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHead({ title, sub, children }) {
  const { viewing } = useApp();
  return (
    <div className="page-head">
      <div>
        <h1>
          {title}
          {viewing.members.length > 1 && (
            <span className="viewing-chip">{viewing.ids ? viewing.label : "Everyone"}</span>
          )}
        </h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function Loading({ error }) {
  if (error === "Not Found") {
    return (
      <div className="card empty">
        <h2>The dashboard was updated</h2>
        <p>
          The server still running is the older version. Close the black "Finance Master" window, then double-click{" "}
          <code>start.bat</code> again.
        </p>
      </div>
    );
  } else {
    return <div className="empty">{error ? `Couldn't load: ${error}` : "Loading…"}</div>;
  }
}

export function Empty({ title, children }) {
  return (
    <div className="card empty">
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  delta,
  deltaLabel,
  goodWhenUp = true,
  hero = false,
  format = money,
  deltaFormat,
  minDelta = 0.5,
  sub,
}) {
  const d = delta != null && Math.abs(delta) >= minDelta;
  const f = (delta ?? 0) > 0;
  const p = d ? (f === goodWhenUp ? "up-good" : "up-bad") : "muted";
  return (
    <div className={`card stat ${hero ? "hero" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value == null ? "–" : format(value)}</div>
      {sub && <div className="small muted">{sub}</div>}
      {delta !== undefined && (
        <div className={`delta ${p}`}>
          {d ? `${f ? "▲" : "▼"} ${(deltaFormat ?? format)(Math.abs(delta))}` : "No change"}
          {deltaLabel && <span className="muted"> {deltaLabel}</span>}
        </div>
      )}
    </div>
  );
}

const SEVERITY = {
  bad: {
    color: "var(--critical)",
    icon: "⛔",
    label: "Needs attention",
  },
  warn: {
    color: "var(--warning)",
    icon: "⚠️",
    label: "Watch",
  },
  info: {
    color: "var(--accent)",
    icon: "ℹ️",
    label: "Note",
  },
  good: {
    color: "var(--good)",
    icon: "✅",
    label: "Good",
  },
};

export function Alert({ severity, title, detail }) {
  const r = SEVERITY[severity];
  return (
    <div
      className="alert"
      style={{
        boxShadow: `inset 3px 0 0 ${r.color}`,
      }}
    >
      <span className="icon" aria-label={r.label} role="img">
        {r.icon}
      </span>
      <div>
        <div className="title">{title}</div>
        {detail && <div className="detail">{detail}</div>}
      </div>
    </div>
  );
}

export function Tabs({ value, options, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((r) => (
        <button
          role="tab"
          aria-selected={r.value === value}
          className={r.value === value ? "on" : ""}
          onClick={() => onChange(r.value)}
          key={r.value}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function hashParams() {
  const e = window.location.hash.split("?")[1] ?? "";
  return new URLSearchParams(e);
}
