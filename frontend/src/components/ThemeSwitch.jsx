import { useEffect, useState } from "react";

function applyTheme(e) {
  if (e === "auto") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = e;
  }
}

export function ThemeSwitch() {
  const [e, t] = useState(() => {
    try {
      return localStorage.getItem("theme-v2") || "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    applyTheme(e);
    try {
      localStorage.setItem("theme-v2", e);
    } catch {}
  }, [e]);
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {["auto", "light", "dark"].map((n) => (
        <button role="radio" aria-checked={e === n} className={e === n ? "on" : ""} onClick={() => t(n)} key={n}>
          {n === "auto" ? "Auto" : n === "light" ? "Light" : "Dark"}
        </button>
      ))}
    </div>
  );
}
