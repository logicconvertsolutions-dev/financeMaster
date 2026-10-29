import { compactMoney, money } from "../format";

const SERIES_COLORS = [
  "var(--s1)",
  "var(--s2)",
  "var(--s3)",
  "var(--s4)",
  "var(--s5)",
  "var(--s6)",
  "var(--s7)",
  "var(--s8)",
];

const OTHER_COLOR = "var(--other)";

export function colorMap(e) {
  const t = {};
  e.forEach((n, r) => (t[n] = n === "Other" ? OTHER_COLOR : (SERIES_COLORS[r] ?? OTHER_COLOR)));
  return t;
}

export function topKeys(e, t = 8) {
  const n = Object.entries(e)
    .sort((r, a) => a[1] - r[1])
    .map(([r]) => r);
  if (n.length <= t) {
    return n;
  } else {
    return [...n.slice(0, t - 1), "Other"];
  }
}

export const axisProps = {
  stroke: "var(--axis)",
  tick: {
    fill: "var(--muted)",
    fontSize: 11.5,
  },
  tickLine: false,
};

export const yAxisProps = {
  ...axisProps,
  axisLine: false,
  width: 56,
  tickFormatter: (e) => compactMoney(e),
};

export const gridProps = {
  stroke: "var(--grid)",
  vertical: false,
};

export function ChartTooltip({
  active,
  payload,
  label,
  labelFormat,
  valueFormat = money,
  total = false,
  reverse = false,
}) {
  if (!active || payload == null || !payload.length) {
    return null;
  }
  const u = payload.filter((d) => d.value != null && d.value !== 0);
  const l = reverse ? [...u].reverse() : u;
  const c = u.reduce((d, f) => d + (f.value ?? 0), 0);
  return (
    <div className="chart-tooltip">
      <div className="t-head">{labelFormat ? labelFormat(String(label)) : label}</div>
      {l.map((d) => (
        <div className="t-row" key={String(d.dataKey ?? d.name)}>
          <span>
            <i
              className="swatch"
              style={{
                background: d.color,
              }}
            />
            {d.name}
          </span>
          <span>{valueFormat(d.value ?? 0)}</span>
        </div>
      ))}
      {total && u.length > 1 && (
        <div
          className="t-row"
          style={{
            borderTop: "1px solid var(--border)",
            marginTop: 4,
            paddingTop: 4,
          }}
        >
          <span>Total</span>
          <span>{valueFormat(c)}</span>
        </div>
      )}
    </div>
  );
}

export function Legend({ items }) {
  if (items.length < 2) {
    return null;
  } else {
    return (
      <div className="legend">
        {items.map((t) => (
          <span key={t.name}>
            <i
              className="swatch"
              style={{
                background: t.color,
              }}
            />
            {t.name}
          </span>
        ))}
      </div>
    );
  }
}

export function BarList({ rows, format = money, color = "var(--s1)", onClick }) {
  const a = Math.max(1, ...rows.map((i) => Math.max(i.value, i.budget ?? 0)));
  return (
    <div className="bar-list">
      {rows.map((i) => (
        <div
          className="bar-row"
          title={`${i.name}: ${format(i.value)}${i.budget ? ` (budget ${format(i.budget)})` : ""}`}
          style={{
            cursor: onClick ? "pointer" : undefined,
          }}
          onClick={() => onClick?.(i.name)}
          key={i.name}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {i.name}
          </span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${(Math.max(i.value, 0) / a) * 100}%`,
                background: i.budget && i.value > i.budget ? "var(--critical)" : color,
              }}
            />
            {i.budget ? (
              <div
                className="bar-budget"
                style={{
                  left: `${(i.budget / a) * 100}%`,
                }}
              />
            ) : null}
          </div>
          <span
            className="num"
            style={{
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {format(i.value)}
            {i.note && <div className="muted small">{i.note}</div>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Sparkline({ values, width = 80, height = 22 }) {
  if (values.length < 2) {
    return null;
  }
  const r = Math.max(...values, 1);
  const a = Math.min(...values, 0);
  const i = (c) => (c / (values.length - 1)) * (width - 6) + 3;
  const o = (c) => height - 3 - ((c - a) / (r - a || 1)) * (height - 6);
  const u = values.map((c, d) => `${d ? "L" : "M"}${i(d).toFixed(1)},${o(c).toFixed(1)}`).join(" ");
  const l = values.length - 1;
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={u} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={i(l)} cy={o(values[l])} r={2.5} fill="var(--s1)" />
    </svg>
  );
}
