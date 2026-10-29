import { useMemo, useState } from "react";
import { IS_WEB, api } from "../api";
import { CategoryOptions } from "../components/CategoryOptions";
import { ConsistencyCheck } from "../components/Checks";
import { Card, PageHead, Tabs, hashParams } from "../components/ui";
import { useApi, useApp, useWeb } from "../context";
import { money } from "../format";

function PhoneSnapshotSettings() {
  const { toast } = useApp();
  const { data, reload } = useApi("/snapshot");
  const [r, a] = useState(false);
  const [i, o] = useState("");
  const [u, l] = useState("");
  const [c, d] = useState("");
  const [f, p] = useState(false);
  if (!data) {
    return null;
  }
  const h = r || !data.enabled;
  const y = data.enabled && !u;
  const b = y || (u.length >= data.min_passphrase && u === c);
  const v = async () => {
    p(true);
    try {
      await api.put("/snapshot", {
        folder: i || data.folder || data.suggestions[0] || "",
        passphrase: y ? null : u,
      });
      a(false);
      l("");
      d("");
      reload();
      toast("Phone snapshot saved");
    } catch (m) {
      toast(m.message);
    } finally {
      p(false);
    }
  };
  return (
    <Card title="Phone app">
      <p
        className="small"
        style={{
          marginTop: 0,
        }}
      >
        The PC saves a locked copy of your data into a folder, e.g. your Google Drive folder. The phone app opens it and
        shows every page, read-only. It's locked with your passphrase, so Google only stores data it can't read.
        Statements and statement passwords are not included.
      </p>
      {data.enabled && data.last && (
        <div
          className="notice"
          style={{
            boxShadow: "inset 3px 0 0 var(--good)",
            marginBottom: 12,
          }}
        >
          Last saved {new Date(data.last.time).toLocaleString()} · {data.last.transactions.toLocaleString()}{" "}
          transactions · {(data.last.size / 1024 / 1024).toFixed(1)} MB
          <div
            className="small muted"
            style={{
              wordBreak: "break-all",
            }}
          >
            {data.last.path}
          </div>
          <div className="small muted">Updates automatically about 20 seconds after each import or change.</div>
        </div>
      )}
      {h ? (
        <div
          className="stack"
          style={{
            gap: 10,
            maxWidth: 560,
          }}
        >
          <label className="field">
            Folder (Google Drive for desktop, OneDrive, or any synced folder)
            <input
              value={i || data.folder || data.suggestions[0] || ""}
              onChange={(m) => o(m.target.value)}
              placeholder={"G:\\My Drive\\Finance Master"}
              list="snapshot-folders"
            />
            <datalist id="snapshot-folders">
              {data.suggestions.map((m) => (
                <option value={m} key={m} />
              ))}
            </datalist>
          </label>
          {!data.suggestions.length && (
            <p
              className="small muted"
              style={{
                margin: 0,
              }}
            >
              No Google Drive folder found on this PC. Install Google Drive for desktop, or type any folder path.
            </p>
          )}
          <label className="field">
            {data.enabled
              ? "New passphrase (leave empty to keep the current one)"
              : "Passphrase: you'll type this on your phone"}
            <input
              type="password"
              value={u}
              onChange={(m) => l(m.target.value)}
              autoComplete="new-password"
              placeholder={`At least ${data.min_passphrase} characters, e.g. four random words`}
            />
          </label>
          {u && (
            <label className="field">
              Type it again
              <input type="password" value={c} onChange={(m) => d(m.target.value)} autoComplete="new-password" />
            </label>
          )}
          {u && c && u !== c && (
            <span
              className="small"
              style={{
                color: "var(--bad-text)",
              }}
            >
              The passphrases don't match.
            </span>
          )}
          <p
            className="small muted"
            style={{
              margin: 0,
            }}
          >
            There's no way to recover a forgotten passphrase, but you can always set a new one here. The PC keeps it in
            Windows Credential Manager.
          </p>
          <div className="row">
            <button className="btn primary" disabled={f || !b} onClick={v}>
              {f ? "Saving…" : "Save & create snapshot"}
            </button>
            {data.enabled && (
              <button className="btn" onClick={() => a(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="row">
          <button
            className="btn"
            disabled={f}
            onClick={async () => {
              p(true);
              try {
                await api.post("/snapshot");
                reload();
                toast("Snapshot updated");
              } catch (m) {
                toast(m.message);
              } finally {
                p(false);
              }
            }}
          >
            Update now
          </button>
          <button className="btn" onClick={() => a(true)}>
            Change folder or passphrase
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              await api.del("/snapshot");
              reload();
            }}
          >
            Turn off
          </button>
        </div>
      )}
    </Card>
  );
}

const KINDS = [
  {
    value: "essential",
    label: "Essential",
  },
  {
    value: "discretionary",
    label: "Discretionary",
  },
  {
    value: "income",
    label: "Income",
  },
  {
    value: "transfer",
    label: "Transfer (not spending)",
  },
  {
    value: "ignore",
    label: "Ignore",
  },
];

export function SettingsPage() {
  const [e, t] = useState(hashParams().get("tab") || "rules");
  return (
    <>
      <PageHead title="Categories & settings" sub="How transactions get sorted, your budgets, and your data.">
        <Tabs
          value={e}
          onChange={t}
          options={[
            {
              value: "rules",
              label: "Auto-categorize",
            },
            {
              value: "categories",
              label: "Categories & budgets",
            },
            {
              value: "data",
              label: "Your data",
            },
          ]}
        />
      </PageHead>
      {e === "rules" && <Rules />}
      {e === "categories" && <Categories />}
      {e === "data" && (
        <div className="stack">
          <ConsistencyCheck />
          {!IS_WEB && <PhoneSnapshotSettings />}
          <YourData />
        </div>
      )}
    </>
  );
}

function Rules() {
  const { bump, toast } = useApp();
  const n = useApi("/rules");
  const r = useApi("/rules/uncategorized");
  const a = useApi("/categories").data ?? [];
  const i = () => {
    n.reload();
    r.reload();
    bump();
  };
  return (
    <div className="stack">
      <Card title="How it works">
        <p
          className="small"
          style={{
            margin: 0,
          }}
        >
          Each transaction's description is checked against keywords. A keyword has to start a word: <code>PHO</code>{" "}
          matches "SAIGON PHO HOUSE" but not "IPHONE", and <code>SUSHI</code> also matches "SUSHIYA". If several
          keywords match, <b>yours win</b>, then the longest one (<code>UBER EATS</code> beats <code>UBER</code>). There
          are about 1,000 built-in keywords for Canadian merchants and food words (pizza, sushi, biryani, shawarma,
          bakery…). Edit or switch off any of them below. Changing a transaction's category on the Spending page also
          adds a keyword here.
        </p>
      </Card>
      <div className="grid g2">
        <Unrecognised
          items={r.data}
          cats={a}
          onSaved={(o) => {
            toast(o);
            i();
          }}
        />
        <AddRule cats={a} onSaved={i} />
      </div>
      <RulesByCategory rules={n.data} cats={a} onChange={i} />
    </div>
  );
}

function Unrecognised({ items, cats, onSaved }) {
  return (
    <Card
      title={`Not recognised yet${items ? ` (${items.length})` : ""}`}
      extra={
        <span className="small muted">
          Pick a category once. Every past and future transaction from that merchant follows.
        </span>
      }
    >
      {items ? (
        items.length === 0 ? (
          <p className="muted">Every transaction matched a keyword. 🎉</p>
        ) : (
          <div
            className="table-wrap"
            style={{
              maxHeight: 420,
            }}
          >
            <table>
              <thead>
                <tr>
                  <th>Merchant / keyword</th>
                  <th className="num">Seen</th>
                  <th className="num">Total</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <UnrecognisedRow u={r} cats={cats} onSaved={onSaved} key={r.merchant} />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <p className="muted">Loading…</p>
      )}
    </Card>
  );
}

function UnrecognisedRow({ u, cats, onSaved }) {
  const [r, a] = useState(u.merchant);
  async function i(o) {
    if (o) {
      await api.post("/rules", {
        pattern: r,
        category: o,
      });
      onSaved(`"${r}" → ${o}`);
    }
  }
  return (
    <tr>
      <td>
        <input
          value={r}
          onChange={(o) => a(o.target.value)}
          style={{
            width: "100%",
            minWidth: 140,
          }}
          aria-label="Keyword"
          title="Edit to make the keyword broader or narrower"
        />
        <div
          className="small muted"
          style={{
            marginTop: 2,
          }}
        >
          {u.example}
        </div>
      </td>
      <td className="num">{u.count}×</td>
      <td className="num">{u.is_income ? `+${money(-u.total)}` : money(u.total)}</td>
      <td>
        <select defaultValue="" onChange={(o) => i(o.target.value)} aria-label={`Category for ${u.merchant}`}>
          <option value="" disabled={true}>
            Choose…
          </option>
          <CategoryOptions cats={cats} />
        </select>
      </td>
    </tr>
  );
}

function AddRule({ cats, onSaved }) {
  const [n, r] = useState("");
  const [a, i] = useState(null);
  const [o, u] = useState("");
  const [l, c] = useState("Dining");
  const { toast } = useApp();
  async function f(p) {
    r(p);
    if (p.trim().length < 2) {
      return i(null);
    }
    const h = await api.post("/rules/test", {
      description: p,
    });
    i(h);
  }
  return (
    <Card title="Add a keyword">
      <form
        className="row"
        style={{
          marginBottom: 14,
        }}
        onSubmit={async (p) => {
          p.preventDefault();
          await api.post("/rules", {
            pattern: o,
            category: l,
          });
          toast(`"${o.toUpperCase()}" → ${l}. Applied to past transactions too.`);
          u("");
          onSaved();
        }}
      >
        <input
          placeholder="Keyword, e.g. BIRYANI or COSTCO GAS"
          value={o}
          onChange={(p) => u(p.target.value)}
          style={{
            flex: 1,
            minWidth: 180,
          }}
          aria-label="Keyword"
        />
        <select value={l} onChange={(p) => c(p.target.value)} aria-label="Category">
          {cats.map((p) => (
            <option key={p.name}>{p.name}</option>
          ))}
        </select>
        <button className="btn primary" disabled={o.trim().length < 2}>
          Add
        </button>
      </form>
      <h3>Try a description</h3>
      <input
        placeholder="Paste a line from a statement…"
        value={n}
        onChange={(p) => f(p.target.value)}
        style={{
          width: "100%",
        }}
        aria-label="Description to test"
      />
      {a && (
        <p
          className="small"
          style={{
            marginBottom: 0,
          }}
        >
          {a.category ? (
            <>
              → <b>{a.category}</b> (keyword <code>{a.pattern}</code>)
            </>
          ) : (
            <>
              → <b>no keyword matches</b>; it would land in Other.
            </>
          )}
          <br />
          <span className="muted">Merchant name used for grouping: {a.merchant}</span>
        </p>
      )}
    </Card>
  );
}

function RulesByCategory({ rules, cats, onChange }) {
  const { toast } = useApp();
  const [a, i] = useState("");
  const [o, u] = useState(false);
  const [l, c] = useState(null);
  const [d, f] = useState({});
  const [p, h] = useState(new Set());
  const y = (w, S) =>
    h((x) => {
      if (x.has(w) === S) {
        return x;
      }
      const j = new Set(x);
      if (S) {
        j.add(w);
      } else {
        j.delete(w);
      }
      return j;
    });
  const b = useMemo(() => {
    var S;
    const w = {};
    for (const x of rules ?? []) {
      if (
        (!!o || !!x.enabled) &&
        (!a || !!x.pattern.includes(a.toUpperCase()) || !!x.category.toUpperCase().includes(a.toUpperCase()))
      ) {
        (w[(S = x.category)] ?? (w[S] = [])).push(x);
      }
    }
    return w;
  }, [rules, a, o]);
  async function v(w, S) {
    try {
      await api.patch(`/rules/${w.id}`, S);
      c(null);
      onChange();
    } catch (x) {
      toast(x.message);
    }
  }
  async function m(w) {
    const S = (d[w] ?? "").trim();
    if (!(S.length < 2)) {
      await api.post("/rules", {
        pattern: S,
        category: w,
      });
      f({
        ...d,
        [w]: "",
      });
      onChange();
    }
  }
  const g = cats.map((w) => w.name).filter((w) => b[w] || !a);
  return (
    <Card
      title="Keywords by category"
      extra={
        <div className="row">
          <input
            placeholder="Search keywords…"
            value={a}
            onChange={(w) => i(w.target.value)}
            aria-label="Search keywords"
          />
          <label
            className="small row"
            style={{
              gap: 4,
            }}
          >
            <input type="checkbox" checked={o} onChange={(w) => u(w.target.checked)} /> show switched-off
          </label>
        </div>
      }
    >
      <p
        className="small muted"
        style={{
          marginTop: 0,
        }}
      >
        Click a keyword to edit, move or switch it off. Blue = yours. The number is how many transactions it currently
        sorts.
      </p>
      {rules ? (
        g.map((w) => {
          const S = (b[w] ?? []).sort((x, j) => j.matches - x.matches || x.pattern.localeCompare(j.pattern));
          return (
            <details
              className="group"
              open={!!a || p.has(w)}
              onToggle={(x) => !a && y(w, x.currentTarget.open)}
              key={w}
            >
              <summary>
                <strong>{w}</strong>
                <span className="muted small">
                  {S.length} keywords · {S.reduce((x, j) => x + j.matches, 0)} transactions
                </span>
              </summary>
              <div
                style={{
                  padding: "10px 0 4px 18px",
                }}
              >
                <div className="chips">
                  {S.map((x) => (
                    <button
                      className={`chip ${x.source === "user" ? "user" : ""} ${x.enabled ? "" : "off"} ${l?.id === x.id ? "active" : ""}`}
                      onClick={() => c(l?.id === x.id ? null : x)}
                      title={x.source === "user" ? "Your keyword" : "Built-in keyword"}
                      key={x.id}
                    >
                      {x.pattern.trim()}
                      {x.matches > 0 && <span className="n">{x.matches}</span>}
                    </button>
                  ))}
                  <form
                    onSubmit={(x) => {
                      x.preventDefault();
                      m(w);
                    }}
                    style={{
                      display: "inline-flex",
                    }}
                  >
                    <input
                      placeholder="+ keyword"
                      value={d[w] ?? ""}
                      onChange={(x) =>
                        f({
                          ...d,
                          [w]: x.target.value,
                        })
                      }
                      style={{
                        width: 120,
                        padding: "2px 8px",
                        fontSize: 12,
                        borderRadius: 999,
                      }}
                      aria-label={`Add keyword to ${w}`}
                    />
                  </form>
                </div>
                {l && l.category === w && (
                  <RuleEditor
                    r={l}
                    cats={cats}
                    onPatch={(x) => v(l, x)}
                    onDelete={async () => {
                      await api.del(`/rules/${l.id}`);
                      c(null);
                      onChange();
                    }}
                    onClose={() => c(null)}
                    key={l.id}
                  />
                )}
              </div>
            </details>
          );
        })
      ) : (
        <p className="muted">Loading…</p>
      )}
    </Card>
  );
}

function RuleEditor({ r: e, cats, onPatch, onDelete, onClose }) {
  const [i, o] = useState(e.pattern);
  const [u, l] = useState(e.category);
  return (
    <div className="editor">
      <input
        value={i}
        onChange={(c) => o(c.target.value)}
        aria-label="Keyword"
        style={{
          minWidth: 180,
        }}
      />
      <span className="muted">→</span>
      <select value={u} onChange={(c) => l(c.target.value)} aria-label="Category">
        {cats.map((c) => (
          <option key={c.name}>{c.name}</option>
        ))}
      </select>
      <button
        className="btn primary small"
        onClick={() =>
          onPatch({
            pattern: i,
            category: u,
          })
        }
        disabled={i === e.pattern && u === e.category}
      >
        Save
      </button>
      <button
        className="btn small"
        onClick={() =>
          onPatch({
            enabled: !e.enabled,
          })
        }
      >
        {e.enabled ? "Switch off" : "Switch on"}
      </button>
      {e.source === "user" && (
        <button className="btn small danger" onClick={onDelete}>
          Delete
        </button>
      )}
      <span className="spacer" />
      <span className="small muted">
        {e.source === "user" ? "Your keyword" : "Built-in"} · sorts {e.matches} transaction{e.matches === 1 ? "" : "s"}
      </span>
      <button className="btn small" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}

function Categories() {
  const { bump, toast } = useApp();
  const { data, reload } = useApi("/categories");
  const [a, i] = useState("");
  const { viewing } = useApp();
  const u = viewing.members.find((c) => c.is_primary);
  async function l(c) {
    await api.post("/categories", c);
    reload();
    bump();
  }
  return (
    <Card
      title="Categories & budgets"
      extra={
        <span className="small muted">
          Only discretionary categories get cutdown suggestions. Budgets show on the Monthly review.
        </span>
      }
    >
      <form
        className="row"
        style={{
          marginBottom: 10,
        }}
        onSubmit={async (c) => {
          c.preventDefault();
          await l({
            name: a,
            kind: "discretionary",
            budget: null,
          });
          i("");
          toast("Category added");
        }}
      >
        <input placeholder="New category" value={a} onChange={(c) => i(c.target.value)} aria-label="New category" />
        <button className="btn" disabled={!a.trim()}>
          Add
        </button>
      </form>
      <div
        className="table-wrap"
        style={{
          maxHeight: 700,
        }}
      >
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Type</th>
              <th className="num">
                {viewing.single
                  ? `${viewing.single.name}'s monthly budget`
                  : viewing.members.length > 1
                    ? `Monthly budget (${u?.name ?? "yours"})`
                    : "Monthly budget"}
              </th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td>
                  <select
                    defaultValue={c.kind}
                    onChange={(d) =>
                      l({
                        ...c,
                        budget: c.own_budget ?? null,
                        kind: d.target.value,
                      })
                    }
                    aria-label={`${c.name} type`}
                  >
                    {KINDS.map((d) => (
                      <option value={d.value} key={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num">
                  {c.kind === "essential" || c.kind === "discretionary" ? (
                    (() => {
                      const d = viewing.single ? c.budget : (c.own_budget ?? null);
                      const f = c.budget ?? null;
                      return (
                        <>
                          <input
                            type="number"
                            placeholder="none"
                            defaultValue={d ?? ""}
                            style={{
                              width: 110,
                              textAlign: "right",
                            }}
                            aria-label={`${c.name} budget`}
                            onBlur={(p) => {
                              const h = p.target.value.trim() === "" ? null : Number(p.target.value);
                              if (h === d) {
                                return;
                              }
                              const y = viewing.single ?? u;
                              if (y) {
                                api
                                  .put("/member-budgets", {
                                    member_id: y.id,
                                    category: c.name,
                                    budget: h,
                                  })
                                  .then(() => {
                                    reload();
                                    bump();
                                  });
                              }
                            }}
                            key={`${viewing.label}-${d}`}
                          />
                          {!viewing.single && f != null && f !== d && (
                            <div className="small muted">family total {f}</div>
                          )}
                        </>
                      );
                    })()
                  ) : (
                    <span className="muted">–</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function YourData() {
  const { toast } = useApp();
  const web = useWeb();
  const { data, reload } = useApi("/passwords");
  const r = useApi("/status").data;
  return (
    <Card title="Your data">
      <p
        className="small"
        style={{
          marginTop: 0,
        }}
      >
        {web ? (
          <>
            Statements are read from your Google Drive folder <b>{web.folder.name}</b>. Your data is saved in the same folder,
            encrypted with your passphrase, as <code>finance-snapshot.fmsnap</code>. To keep a backup, download that file from
            Drive; <code>tools/snapshot_to_db.py</code> turns it back into a database on a PC.
          </>
        ) : (
          <>
            Everything stays on this PC. Statements folder: <code>{r?.statements_dir}</code>. Database:{" "}
            <code>data/finance.db</code>.
          </>
        )}
      </p>
      {!web && <button
        className="btn"
        onClick={async () => {
          const a = await api.post("/backup");
          toast(`Backup saved: ${a.path}`);
        }}
      >
        Create backup (.zip)
      </button>}
      <h3
        style={{
          marginTop: 18,
        }}
      >
        Remembered PDF passwords
      </h3>
      {data && data.length ? (
        <table>
          <tbody>
            {data.map((a) => (
              <tr key={a}>
                <td>{a}</td>
                <td className="muted small">{web ? "saved in your encrypted data" : "stored in Windows Credential Manager"}</td>
                <td>
                  <button
                    className="btn small danger"
                    onClick={async () => {
                      await api.del(`/passwords/${encodeURIComponent(a)}`);
                      reload();
                    }}
                  >
                    Forget
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="small muted">None.</p>
      )}
    </Card>
  );
}
