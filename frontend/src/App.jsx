import { useCallback, useEffect, useMemo, useState } from "react";
import { CONFLICT, IS_WEB, OFFLINE, api, setScope } from "./api";
import { Logo } from "./components/Logo";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { ViewingPicker } from "./components/ViewingPicker";
import { AppContext, useWeb } from "./context";
import { AccountsPage } from "./pages/Accounts";
import { DebtsPage } from "./pages/Debts";
import { FamilyPage } from "./pages/Family";
import { InsurancePage } from "./pages/Insurance";
import { InvestmentsPage } from "./pages/Investments";
import { NetWorthPage } from "./pages/NetWorth";
import { OverviewPage } from "./pages/Overview";
import { PeoplePage } from "./pages/People";
import { ReviewPage } from "./pages/Review";
import { SettingsPage } from "./pages/Settings";
import { SpendingPage } from "./pages/Spending";
import { StatementsPage } from "./pages/Statements";
import { WebStatus } from "./web/WebStatus";

const PAGES = [
  {
    id: "overview",
    label: "Overview",
    el: OverviewPage,
  },
  {
    id: "family",
    label: "Family",
    el: FamilyPage,
  },
  {
    id: "review",
    label: "Monthly review",
    el: ReviewPage,
  },
  {
    id: "spending",
    label: "Spending",
    el: SpendingPage,
  },
  {
    id: "networth",
    label: "Net worth",
    el: NetWorthPage,
  },
  {
    id: "investments",
    label: "Investments",
    el: InvestmentsPage,
  },
  {
    id: "debts",
    label: "Debts",
    el: DebtsPage,
  },
  {
    id: "insurance",
    label: "Insurance",
    el: InsurancePage,
  },
  {
    id: "people",
    label: "People & loans",
    el: PeoplePage,
  },
  {
    id: "sep",
    label: "",
    el: null,
  },
  {
    id: "inbox",
    label: "Statements",
    el: StatementsPage,
  },
  {
    id: "accounts",
    label: "Accounts & assets",
    el: AccountsPage,
  },
  {
    id: "settings",
    label: "Categories & settings",
    el: SettingsPage,
  },
];


function useRoute() {
  const e = () => window.location.hash.replace(/^#\/?/, "") || "overview";
  const [t, n] = useState(e);
  useEffect(() => {
    const a = () => n(e());
    window.addEventListener("hashchange", a);
    return () => window.removeEventListener("hashchange", a);
  }, []);
  const r = useCallback((a) => {
    window.location.hash = `/${a}`;
  }, []);
  return [t, r];
}

export function App() {
  const [e, t] = useRoute();
  const [n, r] = useState(false);
  const a = useCallback(
    (A) => {
      r(false);
      t(A);
    },
    [t],
  );
  const [i, o] = useState(0);
  const [u, l] = useState(null);
  const [c, d] = useState(null);
  const [f, p] = useState(false);
  const [h, y] = useState({
    members: [],
    groups: [],
  });
  const [b, v] = useState(() => {
    try {
      const A = JSON.parse(localStorage.getItem("viewing") ?? "null");
      const E = Array.isArray(A) && A.length ? A : null;
      setScope(E);
      return E;
    } catch {
      return null;
    }
  });
  const m = useCallback((A) => {
    l(A);
    window.setTimeout(() => l((E) => (E === A ? null : E)), 5000);
  }, []);
  const g = useCallback(() => o((A) => A + 1), []);
  const web = useWeb();
  useEffect(() => {
    if (web?.firstToast) {
      m(web.firstToast); // e.g. new statements found while opening
    }
  }, []);
  useEffect(() => {
    const A = (E) => {
      if (E.reason instanceof Error && [OFFLINE, CONFLICT].includes(E.reason.message)) {
        E.preventDefault();
        m(E.reason.message);
      }
    };
    window.addEventListener("unhandledrejection", A);
    return () => window.removeEventListener("unhandledrejection", A);
  }, [m]);
  useEffect(() => {
    // pick up statements put into the folder while the dashboard was closed or in the background
    // (on the web, opening already synced with Drive, and each sync lists the whole folder: once a minute at most)
    let last = IS_WEB ? Date.now() : 0;
    const A = () => {
      if (document.hidden || Date.now() - last < (IS_WEB ? 60000 : 10000)) {
        return;
      }
      last = Date.now();
      api
        .post("/scan")
        .then((E) => {
          if (E.new) {
            m(`${E.new} new file(s) found · ${E.parsed} imported, ${E.needs_review} need review`);
            g();
          }
        })
        .catch(() => {});
    };
    A();
    window.addEventListener("focus", A);
    document.addEventListener("visibilitychange", A);
    return () => {
      window.removeEventListener("focus", A);
      document.removeEventListener("visibilitychange", A);
    };
  }, [m, g]);
  useEffect(() => {
    api
      .get("/status")
      .then(d)
      .catch(() => {});
    api
      .get("/members")
      .then((A) => {
        y(A);
        v((E) => {
          const k = E?.filter((I) => A.members.some((M) => M.id === I)) ?? null;
          const D = k && k.length && k.length < A.members.length ? k : null;
          if (JSON.stringify(D) !== JSON.stringify(E)) {
            setScope(D);
          }
          return D;
        });
      })
      .catch(() => {});
  }, [i]);
  const w = useCallback((A) => {
    setScope(A);
    v(A);
    try {
      localStorage.setItem("viewing", JSON.stringify(A));
    } catch {}
    o((E) => E + 1);
  }, []);
  const S = useMemo(() => {
    const A = b ? h.members.filter((D) => b.includes(D.id)) : [];
    const E = b && h.groups.find((D) => D.member_ids.length === b.length && D.member_ids.every((I) => b.includes(I)));
    return {
      label: b ? (E ? E.name : A.map((D) => D.name).join(" + ") || "Everyone") : "Everyone",
      ids: b,
      single: A.length === 1 ? A[0] : null,
      members: h.members,
    };
  }, [b, h]);
  const x = S.single ? `/upload?member_id=${S.single.id}` : "/upload";
  useEffect(() => {
    // drop statement files anywhere on the window to import them
    let depth = 0;
    const hasFiles = (E) => Array.from(E.dataTransfer?.types ?? []).includes("Files");
    const enter = (E) => {
      if (!hasFiles(E)) {
        return;
      }
      E.preventDefault();
      depth++;
      p(true);
    };
    const over = (E) => hasFiles(E) && E.preventDefault();
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) {
        p(false);
      }
    };
    const drop = async (E) => {
      if (!hasFiles(E)) {
        return;
      }
      E.preventDefault();
      depth = 0;
      p(false);
      try {
        const k = await api.upload(x, E.dataTransfer.files);
        m(`${k.saved.length} file(s) saved · ${k.parsed} imported, ${k.needs_review} need review, ${k.locked} locked, ${k.failed} unreadable`);
        g();
      } catch (k) {
        m(`Upload failed: ${k.message}`);
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [m, g, x]);
  useEffect(() => {
    if (!n) {
      return;
    }
    const A = (E) => E.key === "Escape" && r(false);
    document.addEventListener("keydown", A);
    document.body.classList.add("no-scroll");
    return () => {
      document.removeEventListener("keydown", A);
      document.body.classList.remove("no-scroll");
    };
  }, [n]);
  const j = c ? (c.statements.needs_review ?? 0) + (c.statements.locked ?? 0) + (c.statements.failed ?? 0) : 0;
  const _ = e.split("?")[0];
  const O = PAGES.find((A) => A.id === _ && A.el) ?? PAGES[0];
  const P = O.el;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [O.id]);
  return (
    <AppContext.Provider
      value={{
        version: i,
        bump: g,
        toast: m,
        viewing: S,
      }}
    >
      <div className={`app ${n ? "menu-open" : ""}`}>
        <header className="topbar">
          <button
            className="menu-btn"
            onClick={() => r(true)}
            aria-label="Open menu"
            aria-expanded={n}
            aria-controls="sidebar"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {j > 0 && <span className="menu-dot" aria-label={`${j} statements need attention`} />}
          </button>
          <Logo />
          <span className="topbar-title">{O.label}</span>
        </header>
        <nav className="sidebar" id="sidebar" aria-label="Pages">
          <div className="brand">
            <Logo />
            Finance Master
            <button className="menu-close" onClick={() => r(false)} aria-label="Close menu">
              ✕
            </button>
          </div>
          <ViewingPicker members={h.members} groups={h.groups} ids={b} onChange={w} onGroupsChanged={g} go={a} />
          {PAGES.filter((A) => (A.id !== "family" || h.members.length > 1)).map((A) =>
            A.id === "sep" ? (
              <div className="nav-sep" key="sep" />
            ) : (
              <button className={`nav-item ${O.id === A.id ? "active" : ""}`} onClick={() => a(A.id)} key={A.id}>
                {A.label}
                {A.id === "inbox" && j > 0 && (
                  <span className="count-pill" aria-label={`${j} need attention`}>
                    {j}
                  </span>
                )}
              </button>
            ),
          )}
          <div className="sidebar-foot">
            <WebStatus />
            <ThemeSwitch />
          </div>
        </nav>
        {n && <div className="scrim" onClick={() => r(false)} aria-hidden="true" />}
        <main>
          <P go={a} />
        </main>
      </div>
      {f && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--accent-wash)",
            border: "3px dashed var(--accent)",
            display: "grid",
            placeItems: "center",
            zIndex: 40,
            fontSize: 18,
            fontWeight: 600,
            pointerEvents: "none",
          }}
        >
          Drop statements to import them{S.single ? ` into ${S.single.name}'s folder` : ""}
        </div>
      )}
      {u && (
        <div className="toast" role="status">
          {u}
        </div>
      )}
    </AppContext.Provider>
  );
}
