// Gradients shared by every chart: styles.css swaps a plain series colour for its glossy version.
const SERIES = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "other"];

const mix = (name, pct, toward) => `color-mix(in srgb, var(--${name}) ${pct}%, ${toward})`;

export function ChartDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      <defs>
        {SERIES.map((s) => (
          <linearGradient id={`gloss-${s}`} x1="0" y1="0" x2="1" y2="0" key={`g-${s}`}>
            <stop offset="0" style={{ stopColor: mix(s, 72, "black") }} />
            <stop offset="0.38" style={{ stopColor: mix(s, 72, "white") }} />
            <stop offset="0.6" style={{ stopColor: `var(--${s})` }} />
            <stop offset="1" style={{ stopColor: mix(s, 62, "black") }} />
          </linearGradient>
        ))}
        {SERIES.map((s) => (
          <linearGradient id={`area-${s}`} x1="0" y1="0" x2="0" y2="1" key={`a-${s}`}>
            <stop offset="0" style={{ stopColor: `var(--${s})`, stopOpacity: 0.55 }} />
            <stop offset="1" style={{ stopColor: `var(--${s})`, stopOpacity: 0.03 }} />
          </linearGradient>
        ))}
      </defs>
    </svg>
  );
}
