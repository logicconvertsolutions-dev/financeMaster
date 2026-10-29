const wholeDollars = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0,
});

const cents = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
});

export const money = (e) => (e == null ? "–" : wholeDollars.format(e));

export const moneyCents = (e) => (e == null ? "–" : cents.format(e));

export function compactMoney(e) {
  const t = Math.abs(e);
  const n = e < 0 ? "-" : "";
  if (t >= 1000000) {
    return `${n}$${(t / 1000000).toFixed(1)}M`;
  } else if (t >= 10000) {
    return `${n}$${Math.round(t / 1000)}K`;
  } else if (t >= 1000) {
    return `${n}$${(t / 1000).toFixed(1)}K`;
  } else {
    return `${n}$${Math.round(t)}`;
  }
}

export const pct = (e, t = 0) => (e == null ? "–" : `${(e * 100).toFixed(t)}%`);

export const signedMoney = (e) => `${e > 0 ? "+" : e < 0 ? "−" : ""}${wholeDollars.format(Math.abs(e))}`;

export function monthLabel(e, t = false) {
  const [n, r] = e.split("-").map(Number);
  return new Date(n, r - 1, 1).toLocaleDateString("en-CA", {
    month: t ? "long" : "short",
    year: t ? "numeric" : "2-digit",
  });
}

export const dayLabel = (e) =>
  new Date(`${e}T00:00:00`).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
  });

export const today = () => {
  const e = new Date();
  return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}`;
};

export function parseAmount(e) {
  const t = e.trim().replace(/[$\s,]/g, "");
  if (!t) {
    return NaN;
  }
  const n = /^\(.*\)$/.test(t) || t.startsWith("-");
  const r = Number(t.replace(/[()\-]/g, ""));
  if (isNaN(r)) {
    return NaN;
  } else if (n) {
    return -r;
  } else {
    return r;
  }
}
