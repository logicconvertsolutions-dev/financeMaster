import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip, Legend, axisProps, gridProps, yAxisProps } from "../components/charts";
import { Card, Empty, Loading, PageHead } from "../components/ui";
import { useApi, useApp } from "../context";
import { money, monthLabel, pct, signedMoney } from "../format";

export function FamilyPage({ go }) {
  const { viewing } = useApp();
  const [n, r] = useState(null);
  const { data, error } = useApi(`/family${n ? `?month=${n}` : ""}`);
  const o = useApi("/spending?months=12").data;
  if (viewing.members.length < 2) {
    return (
      <>
        <PageHead title="Family" />
        <Empty title="Add a family member first">
          Put their statements in their own folder, e.g. <code>statements\Sam\</code>, or add them on Accounts & assets.
          <p>
            <button className="btn primary" onClick={() => go("accounts")}>
              Family members
            </button>
          </p>
        </Empty>
      </>
    );
  }
  if (!data) {
    return <Loading error={error} />;
  }
  if (data.empty || data.people.length === 0) {
    return (
      <>
        <PageHead title="Family" />
        <Empty title="No statements yet">Import statements for the people you're viewing.</Empty>
      </>
    );
  }
  const u = data.months_available.indexOf(data.month);
  const l = data.people;
  const c = (d) => {
    return l.find((p) => p.name === d)?.color ?? "var(--other)";
  };
  return (
    <>
      <PageHead
        title={`Family · ${monthLabel(data.month, true)}`}
        sub="Everyone side by side. Money moved between you isn't counted as anyone's spending or income."
      >
        <button
          className="btn"
          disabled={u <= 0}
          onClick={() => r(data.months_available[u - 1])}
          aria-label="Previous month"
        >
          ‹
        </button>
        <select value={data.month} onChange={(d) => r(d.target.value)} aria-label="Month">
          {[...data.months_available].reverse().map((d) => (
            <option value={d} key={d}>
              {monthLabel(d, true)}
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={u >= data.months_available.length - 1}
          onClick={() => r(data.months_available[u + 1])}
          aria-label="Next month"
        >
          ›
        </button>
      </PageHead>
      <div
        className="grid family-grid"
        style={{
          gridTemplateColumns: `repeat(${Math.min(l.length + 1, 4)}, minmax(0, 1fr))`,
        }}
      >
        {l.map((d) => (
          <div
            className="card"
            style={{
              boxShadow: `inset 4px 0 0 ${d.color ?? "var(--other)"}`,
            }}
            key={d.id}
          >
            <div
              className="row"
              style={{
                justifyContent: "space-between",
              }}
            >
              <strong
                style={{
                  fontSize: 16,
                }}
              >
                {d.name}
              </strong>
              {!d.has_data && <span className="badge">no statements this month</span>}
            </div>
            <PersonSummary p={d} />
            {d.top_increase && (
              <div
                className="small"
                style={{
                  marginTop: 8,
                }}
              >
                ▲ {d.top_increase.category} up {money(d.top_increase.delta)} vs usual
              </div>
            )}
            {(d.family_sent > 0 || d.family_received > 0) && (
              <div
                className="small muted"
                style={{
                  marginTop: 4,
                }}
              >
                Family money: {d.family_sent > 0 && `sent ${money(d.family_sent)}`}
                {d.family_sent > 0 && d.family_received > 0 && " · "}
                {d.family_received > 0 && `received ${money(d.family_received)}`}
              </div>
            )}
          </div>
        ))}
        <div
          className="card"
          style={{
            background: "var(--accent-wash)",
          }}
        >
          <strong
            style={{
              fontSize: 16,
            }}
          >
            {viewing.ids ? viewing.label : "Household"}
          </strong>
          <PersonSummary
            p={{
              ...data.household,
              essential: 0,
              discretionary: 0,
              expenses_change: null,
            }}
          />
        </div>
      </div>
      <div
        className="grid g2"
        style={{
          marginTop: 16,
        }}
      >
        <Card
          title="Who paid for essentials"
          extra={<span className="small muted">rent, groceries, utilities, insurance…</span>}
        >
          <div
            className="stack"
            style={{
              gap: 10,
            }}
          >
            {data.essentials.map((d) => (
              <div key={d.name}>
                <div
                  className="row"
                  style={{
                    justifyContent: "space-between",
                  }}
                >
                  <span>
                    <i
                      className="member-dot"
                      style={{
                        background: c(d.name),
                      }}
                    />
                    {d.name}
                  </span>
                  <span>
                    {money(d.amount)}
                    {d.share != null && <span className="muted"> · {pct(d.share)}</span>}
                  </span>
                </div>
                <div
                  className="meter"
                  style={{
                    marginTop: 4,
                  }}
                >
                  <div
                    style={{
                      width: `${(d.share ?? 0) * 100}%`,
                      background: c(d.name),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Spending by person, last 12 months">
          {o && o.members.length > 1 ? (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={o.monthly_by_member}
                  margin={{
                    top: 8,
                    right: 8,
                    left: 0,
                    bottom: 0,
                  }}
                  barCategoryGap="30%"
                >
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="month" tickFormatter={(d) => monthLabel(d)} {...axisProps} />
                  <YAxis {...yAxisProps} />
                  <Tooltip
                    cursor={{
                      fill: "var(--surface-2)",
                    }}
                    content={<ChartTooltip total={true} reverse={true} labelFormat={(d) => monthLabel(d, true)} />}
                  />
                  {o.members.map((d, f) => (
                    <Bar
                      dataKey={d.name}
                      name={d.name}
                      stackId="p"
                      fill={d.color ?? "var(--other)"}
                      maxBarSize={28}
                      stroke="var(--surface)"
                      strokeWidth={1}
                      radius={f === o.members.length - 1 ? [4, 4, 0, 0] : undefined}
                      key={d.name}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <Legend
                items={o.members.map((d) => ({
                  name: d.name,
                  color: d.color ?? "var(--other)",
                }))}
              />
            </>
          ) : (
            <p className="muted">Needs spending from at least two people.</p>
          )}
        </Card>
      </div>
      <section
        className="card flush"
        style={{
          marginTop: 16,
        }}
      >
        <div
          style={{
            padding: "14px 18px 4px",
          }}
        >
          <h2>Spending by category · {monthLabel(data.month, true)}</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                {l.map((d) => (
                  <th className="num" key={d.id}>
                    <i
                      className="member-dot"
                      style={{
                        background: d.color ?? "var(--other)",
                      }}
                    />
                    {d.name}
                  </th>
                ))}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((d) => {
                const f = Math.max(...l.map((p) => d.by_person[p.name] ?? 0));
                return (
                  <tr key={d.category}>
                    <td>
                      {d.category}
                      <span className="muted small"> · {d.kind}</span>
                    </td>
                    {l.map((p) => {
                      const h = d.by_person[p.name];
                      return (
                        <td
                          className="num"
                          style={{
                            fontWeight: h && h === f && l.length > 1 ? 650 : 400,
                          }}
                          key={p.id}
                        >
                          {h ? money(h) : <span className="muted">–</span>}
                        </td>
                      );
                    })}
                    <td className="num">{money(d.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function PersonSummary({ p }) {
  return (
    <div
      className="stack"
      style={{
        gap: 4,
        marginTop: 8,
      }}
    >
      <SummaryLine label="Income" value={money(p.income)} />
      <SummaryLine
        label="Spending"
        value={money(p.expenses)}
        extra={
          p.expenses_change != null && Math.abs(p.expenses_change) >= 1 ? (
            <span className={p.expenses_change > 0 ? "up-bad" : "up-good"}>
              {" "}
              {p.expenses_change > 0 ? "▲" : "▼"} {money(Math.abs(p.expenses_change))}
            </span>
          ) : null
        }
      />
      <SummaryLine
        label="Saved"
        value={`${signedMoney(p.net)}${p.savings_rate != null ? ` · ${pct(p.savings_rate)}` : ""}`}
      />
      {p.net_worth != null && <SummaryLine label="Net worth" value={money(p.net_worth)} />}
    </div>
  );
}

function SummaryLine({ label, value, extra }) {
  return (
    <div
      className="row"
      style={{
        justifyContent: "space-between",
        flexWrap: "nowrap",
      }}
    >
      <span className="muted small">{label}</span>
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
        <span className="small">{extra}</span>
      </span>
    </div>
  );
}
