import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { CategoryOptions } from "../components/CategoryOptions";
import {
  BarList,
  ChartTooltip,
  Legend,
  axisProps,
  colorMap,
  gridProps,
  topKeys,
  yAxisProps,
} from "../components/charts";
import { Card, Empty, Loading, PageHead, Tabs, hashParams } from "../components/ui";
import { useApi, useApp } from "../context";
import { dayLabel, money, moneyCents, monthLabel } from "../format";

export function SpendingPage({ go }) {
  const t = hashParams();
  const [n, r] = useState(12);
  const [a, i] = useState("category");
  const [o, u] = useState(t.get("category") ?? "");
  const [l, c] = useState(t.get("month") ?? "");
  const [d, f] = useState("");
  const { data, error } = useApi(`/spending?months=${n}`);
  const y = useApi("/categories").data ?? [];
  const b = useMemo(() => {
    if (!data) {
      return null;
    }
    const v = Object.fromEntries(data.categories.map((S) => [S.name, S.total]));
    const m = topKeys(v, 8);
    const g = colorMap(m);
    const w = data.monthly.map((S) => {
      const x = {
        month: S.month,
      };
      for (const [j, _] of Object.entries(S.by_category)) {
        const O = m.includes(j) ? j : "Other";
        x[O] = (x[O] ?? 0) + _;
      }
      return x;
    });
    return {
      keys: m,
      colors: g,
      rows: w,
    };
  }, [data]);
  if (!data || !b) {
    return <Loading error={error} />;
  } else if (data.months.length) {
    return (
      <>
        <PageHead title="Spending" sub="Transfers between your own accounts and card payments are excluded.">
          <select value={n} onChange={(v) => r(Number(v.target.value))} aria-label="Range">
            <option value={3}>Last 3 months</option>
            <option value={6}>Last 6 months</option>
            <option value={12}>Last 12 months</option>
            <option value={36}>Last 3 years</option>
          </select>
        </PageHead>
        <Card
          title={a === "person" ? "Monthly spending by person" : "Monthly spending by category"}
          extra={
            data.members.length > 1 && (
              <Tabs
                value={a}
                onChange={i}
                options={[
                  {
                    value: "category",
                    label: "By category",
                  },
                  {
                    value: "person",
                    label: "By person",
                  },
                ]}
              />
            )
          }
        >
          {a === "person" && data.members.length > 1 ? (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={data.monthly_by_member}
                  margin={{
                    top: 8,
                    right: 8,
                    left: 0,
                    bottom: 0,
                  }}
                  barCategoryGap="30%"
                >
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="month" tickFormatter={(v) => monthLabel(v)} {...axisProps} />
                  <YAxis {...yAxisProps} />
                  <Tooltip
                    cursor={{
                      fill: "var(--surface-2)",
                    }}
                    content={<ChartTooltip total={true} reverse={true} labelFormat={(v) => monthLabel(v, true)} />}
                  />
                  {data.members.map((v, m) => (
                    <Bar
                      dataKey={v.name}
                      name={v.name}
                      stackId="p"
                      fill={v.color ?? "var(--other)"}
                      maxBarSize={32}
                      stroke="var(--surface)"
                      strokeWidth={1}
                      radius={m === data.members.length - 1 ? [4, 4, 0, 0] : undefined}
                      key={v.name}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <Legend
                items={data.members.map((v) => ({
                  name: v.name,
                  color: v.color ?? "var(--other)",
                }))}
              />
            </>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={b.rows}
                  margin={{
                    top: 8,
                    right: 8,
                    left: 0,
                    bottom: 0,
                  }}
                  barCategoryGap="30%"
                >
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="month" tickFormatter={(v) => monthLabel(v)} {...axisProps} />
                  <YAxis {...yAxisProps} />
                  <Tooltip
                    cursor={{
                      fill: "var(--surface-2)",
                    }}
                    content={<ChartTooltip total={true} reverse={true} labelFormat={(v) => monthLabel(v, true)} />}
                  />
                  {b.keys.map((v, m) => (
                    <Bar
                      dataKey={v}
                      name={v}
                      stackId="s"
                      fill={b.colors[v]}
                      maxBarSize={32}
                      stroke="var(--surface)"
                      strokeWidth={1}
                      radius={m === b.keys.length - 1 ? [4, 4, 0, 0] : undefined}
                      style={{
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        u(v === "Other" ? "" : v);
                      }}
                      key={v}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <Legend
                items={b.keys.map((v) => ({
                  name: v,
                  color: b.colors[v],
                }))}
              />
            </>
          )}
        </Card>
        {data.partial_months.length > 0 && (
          <p
            className="small muted"
            style={{
              margin: "6px 2px 0",
            }}
          >
            {data.partial_months.map((v) => monthLabel(v, true)).join(", ")}: not all statements are in yet, so the last
            bar is lower than it will be.
          </p>
        )}
        {data.budgets.length > 0 && data.budget_month && (
          <Card
            title={`Budgets · ${monthLabel(data.budget_month, true)}`}
            style={{
              marginTop: 16,
            }}
            extra={
              <button className="btn small" onClick={() => go("settings")}>
                Edit budgets
              </button>
            }
          >
            <div
              className="stack"
              style={{
                gap: 8,
              }}
            >
              {data.budgets.map((v) => {
                const m = v.spent / v.budget;
                return (
                  <div
                    className="budget-row"
                    style={{
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      u(v.name);
                      c(data.budget_month);
                    }}
                    key={v.name}
                  >
                    <span>{v.name}</span>
                    <div className="meter">
                      <div
                        style={{
                          width: `${Math.min(100, m * 100)}%`,
                          background: m > 1 ? "var(--critical)" : m > 0.9 ? "var(--warning)" : undefined,
                        }}
                      />
                    </div>
                    <span className={`small num ${m > 1 ? "up-bad" : ""}`}>
                      {money(v.spent)} of {money(v.budget)}
                    </span>
                    <span className="small muted num">
                      {m > 1 ? `${money(v.spent - v.budget)} over` : `${money(v.budget - v.spent)} left`} · usual{" "}
                      {money(v.avg)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
        <div
          className="grid g2"
          style={{
            marginTop: 16,
          }}
        >
          <Card
            title={`By category · ${data.months.length} month total`}
            extra={<span className="muted small">monthly average on the right</span>}
          >
            <BarList
              rows={data.categories.map((v) => ({
                name: v.name,
                value: v.total,
                note: `${money(v.monthly_avg)}/mo`,
              }))}
              onClick={(v) => u(v)}
            />
          </Card>
          <Card title="Top merchants">
            <table>
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Category</th>
                  <th className="num">Visits</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.merchants.slice(0, 15).map((v) => (
                  <tr
                    style={{
                      cursor: "pointer",
                    }}
                    onClick={() => f(v.merchant)}
                    key={v.merchant}
                  >
                    <td>{v.merchant}</td>
                    <td className="muted">{v.category}</td>
                    <td className="num">{v.count}</td>
                    <td className="num">{money(v.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
        <Transactions
          cats={y}
          category={o}
          setCategory={u}
          month={l}
          setMonth={c}
          months={data.months}
          q={d}
          setQ={f}
          go={go}
        />
      </>
    );
  } else {
    return (
      <>
        <PageHead title="Spending" />
        <Empty title="No spending yet">Import chequing and credit card statements to see where your money goes.</Empty>
      </>
    );
  }
}

function Transactions({ cats, category, setCategory, month, setMonth, months, q, setQ }) {
  const { bump, toast, viewing } = useApp();
  const f = viewing.members.length > 1 && !viewing.single;
  const p = new URLSearchParams();
  if (category) {
    p.set("category", category);
  }
  if (month) {
    p.set("month", month);
  }
  if (q) {
    p.set("q", q);
  }
  p.set("limit", "2000");
  const { data, reload } = useApi(`/transactions?${p}`);
  const [b, v] = useState(new Set());
  const m = data ?? [];
  async function g(j) {
    if (!j) {
      return;
    }
    const _ = [...b];
    for (const O of _) {
      await api.patch(`/transactions/${O}`, {
        category: j,
        apply_to_similar: false,
      });
    }
    toast(`${_.length} transaction(s) moved to ${j}.`);
    v(new Set());
    reload();
    bump();
  }
  function w() {
    const j = (A) => `"${String(A ?? "").replace(/"/g, '""')}"`;
    const _ = [["Date", "Description", "Merchant", "Account", "Person", "Category", "Amount", "Transfer"].join(",")];
    for (const A of m) {
      _.push(
        [
          A.date,
          A.description,
          A.merchant,
          A.account,
          A.member ?? "",
          A.category ?? "",
          A.amount.toFixed(2),
          A.is_transfer ? "yes" : "",
        ]
          .map(j)
          .join(","),
      );
    }
    const O = URL.createObjectURL(
      new Blob(
        [
          _.join(`\r
`),
        ],
        {
          type: "text/csv",
        },
      ),
    );
    const P = document.createElement("a");
    P.href = O;
    P.download = `transactions${month ? `-${month}` : ""}${category ? `-${category.replace(/\W+/g, "_")}` : ""}.csv`;
    P.click();
    URL.revokeObjectURL(O);
  }
  async function S(j, _) {
    const O = window.confirm(`Also file other "${j.merchant}" transactions under ${_}?

OK = all of them (creates a rule)   Cancel = just this one`);
    try {
      const P = await api.patch(`/transactions/${j.id}`, {
        category: _,
        apply_to_similar: O,
      });
      toast(O ? `${P.changed} transaction(s) moved to ${_}. Future ones will be too.` : `Moved to ${_}.`);
      reload();
      bump();
    } catch (P) {
      toast(String(P.message));
    }
  }
  const x = (data ?? []).filter((j) => !j.is_transfer).reduce((j, _) => j + _.amount, 0);
  return (
    <section
      className="card flush"
      style={{
        marginTop: 16,
      }}
    >
      <div
        style={{
          padding: "14px 18px",
        }}
        className="row"
      >
        <h2
          style={{
            margin: 0,
          }}
        >
          Transactions
        </h2>
        <span className="spacer" />
        <input placeholder="Search description…" value={q} onChange={(j) => setQ(j.target.value)} aria-label="Search" />
        <select value={month} onChange={(j) => setMonth(j.target.value)} aria-label="Month">
          <option value="">All months</option>
          {[...months].reverse().map((j) => (
            <option value={j} key={j}>
              {monthLabel(j, true)}
            </option>
          ))}
        </select>
        <select value={category} onChange={(j) => setCategory(j.target.value)} aria-label="Category">
          <option value="">All categories</option>
          <CategoryOptions cats={cats} />
        </select>
        {(q || month || category) && (
          <button
            className="btn small"
            onClick={() => {
              setQ("");
              setMonth("");
              setCategory("");
            }}
          >
            Clear
          </button>
        )}
        <button
          className="btn small"
          onClick={w}
          disabled={!m.length}
          title="Download the transactions shown, as a spreadsheet"
        >
          Export CSV
        </button>
      </div>
      {b.size > 0 && (
        <div
          className="row small"
          style={{
            padding: "0 18px 10px",
          }}
        >
          <strong>{b.size} selected</strong>
          <select value="" onChange={(j) => g(j.target.value)} aria-label="Move selected to category">
            <option value="">Move to category…</option>
            <CategoryOptions cats={cats} />
          </select>
          <button className="btn small" onClick={() => v(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th
                style={{
                  width: 28,
                }}
              >
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={b.size > 0 && b.size === m.length}
                  onChange={(j) => v(j.target.checked ? new Set(m.map((_) => _.id)) : new Set())}
                />
              </th>
              <th>Date</th>
              <th>Description</th>
              {f && <th>Person</th>}
              <th>Account</th>
              <th>Category</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((j) => (
              <tr
                style={{
                  opacity: j.is_transfer ? 0.6 : 1,
                }}
                key={j.id}
              >
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${j.description}`}
                    checked={b.has(j.id)}
                    onChange={(_) => {
                      const O = new Set(b);
                      if (_.target.checked) {
                        O.add(j.id);
                      } else {
                        O.delete(j.id);
                      }
                      v(O);
                    }}
                  />
                </td>
                <td
                  className="muted"
                  style={{
                    whiteSpace: "nowrap",
                  }}
                >
                  {dayLabel(j.date)}
                </td>
                <td>
                  {j.description}
                  {j.is_transfer ? (
                    <span
                      className="badge"
                      style={{
                        marginLeft: 6,
                      }}
                    >
                      transfer
                    </span>
                  ) : null}
                </td>
                {f && <td className="small">{j.member}</td>}
                <td className="muted small">{j.account}</td>
                <td>
                  <select
                    className="inline-select"
                    value={j.category ?? "Other"}
                    onChange={(_) => S(j, _.target.value)}
                    aria-label="Category"
                    title={j.category_source === "user" ? "Set by you" : "Set by a rule"}
                  >
                    <CategoryOptions cats={cats} />
                  </select>
                  {j.category_source === "user" && (
                    <span className="muted small" title="Set by you">
                      {" "}
                      ✎
                    </span>
                  )}
                </td>
                <td className={`num ${j.amount > 0 ? "up-good" : ""}`}>
                  {j.amount > 0 ? "+" : ""}
                  {moneyCents(j.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.length === 0 && (
          <p
            className="muted"
            style={{
              padding: 18,
            }}
          >
            No transactions match.
          </p>
        )}
      </div>
      {data && data.length > 0 && (
        <div
          style={{
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
          }}
          className="small muted"
        >
          {data.length} transactions · net {moneyCents(x)} (excluding transfers)
        </div>
      )}
    </section>
  );
}
