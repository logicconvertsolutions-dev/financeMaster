import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip, Legend, axisProps, colorMap, gridProps, yAxisProps } from "../components/charts";
import { Card, Empty, Loading, PageHead, Stat } from "../components/ui";
import { useApi } from "../context";
import { money, moneyCents, monthLabel, pct } from "../format";

export function DebtsPage({ go }) {
  const { data, error } = useApi("/debts");
  if (!data) {
    return <Loading error={error} />;
  }
  if (!data.items.length) {
    return (
      <>
        <PageHead title="Debts" />
        <Empty title="No debts recorded 🎉">
          Credit card and loan statements show up here. Mortgages, car loans or student loans without statements can be
          added by hand.
          <p>
            <button className="btn" onClick={() => go("accounts")}>
              Accounts & assets
            </button>
          </p>
        </Empty>
      </>
    );
  }
  const r = data.items.map((f) => f.name);
  const a = colorMap(r.slice(0, 8));
  const i = data.items.filter((f) => f.type === "credit");
  const o = i.reduce((f, p) => f + (p.credit_limit ?? 0), 0);
  const u = i.reduce((f, p) => f + p.balance, 0);
  const l = data.interest_and_fees.slice(-12).reduce((f, p) => f + p.amount, 0);
  const c = data.items.reduce((f, p) => f + (p.yearly_interest ?? 0), 0);
  const d = data.items
    .filter((f) => f.interest_rate && f.balance > 0)
    .sort((f, p) => p.interest_rate - f.interest_rate);
  return (
    <>
      <PageHead title="Debts" sub="Credit cards, loans and anything else you owe." />
      <div className="grid g4">
        <Stat hero={true} label="Total owed" value={data.total} />
        <Stat label="Credit card balances" value={u} />
        <Stat label="Overall card utilization" value={o ? u / o : null} format={(f) => pct(f)} />
        <Stat label="Interest & fees, last 12 months" value={l} format={moneyCents} />
      </div>
      <div
        className="grid g2"
        style={{
          marginTop: 16,
        }}
      >
        <Card title="Balances over time">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart
              data={data.series}
              margin={{
                top: 8,
                right: 8,
                left: 0,
                bottom: 0,
              }}
            >
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="month" tickFormatter={(f) => monthLabel(f)} {...axisProps} />
              <YAxis {...yAxisProps} />
              <Tooltip content={<ChartTooltip labelFormat={(f) => monthLabel(f, true)} />} />
              {r.slice(0, 8).map((f) => (
                <Line
                  dataKey={f}
                  name={f}
                  stroke={a[f]}
                  strokeWidth={2}
                  dot={{
                    r: 3,
                    fill: a[f],
                    stroke: "var(--surface)",
                    strokeWidth: 2,
                  }}
                  connectNulls={true}
                  key={f}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <Legend
            items={r.slice(0, 8).map((f) => ({
              name: f,
              color: a[f],
            }))}
          />
        </Card>
        <Card title="Interest & fees paid">
          {data.interest_and_fees.length === 0 ? (
            <p className="muted">None found. Nice.</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                data={data.interest_and_fees}
                margin={{
                  top: 8,
                  right: 8,
                  left: 0,
                  bottom: 0,
                }}
                barCategoryGap="30%"
              >
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="month" tickFormatter={(f) => monthLabel(f)} {...axisProps} />
                <YAxis {...yAxisProps} />
                <Tooltip
                  cursor={{
                    fill: "var(--surface-2)",
                  }}
                  content={<ChartTooltip valueFormat={moneyCents} labelFormat={(f) => monthLabel(f, true)} />}
                />
                <Bar dataKey="amount" name="Interest & fees" fill="var(--s8)" radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
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
          className="card-head"
        >
          <h2>Details</h2>
          <button className="btn small" onClick={() => go("accounts")}>
            Set rates & payments
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Debt</th>
              <th>As of</th>
              <th className="num">Balance</th>
              <th>Utilization</th>
              <th className="num">Rate</th>
              <th className="num">Interest / yr</th>
              <th className="num">Payment</th>
              <th>Last statement</th>
              <th>Paid off</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((f) => {
              return (
                <tr key={`${f.account_id}-${f.name}`}>
                  <td>{f.name}</td>
                  <td className="muted">{f.as_of}</td>
                  <td className="num">{moneyCents(f.balance)}</td>
                  <td
                    style={{
                      minWidth: 140,
                    }}
                  >
                    {f.utilization != null ? (
                      <div
                        className="row"
                        style={{
                          gap: 8,
                          flexWrap: "nowrap",
                        }}
                      >
                        <div
                          className="meter"
                          style={{
                            flex: 1,
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.min(100, f.utilization * 100)}%`,
                              background: f.utilization > 0.3 ? "var(--warning)" : undefined,
                            }}
                          />
                        </div>
                        <span className="small">
                          {pct(f.utilization)}
                          {f.utilization > 0.3 ? " ⚠️" : ""}
                        </span>
                      </div>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td className="num">{f.interest_rate != null ? `${f.interest_rate}%` : "–"}</td>
                  <td className="num">
                    {f.yearly_interest != null ? (
                      <span title="What the current balance costs over a year at this rate">
                        {money(f.yearly_interest)}
                      </span>
                    ) : (
                      "–"
                    )}
                    {f.interest_12m > 0 && (
                      <div
                        className="small muted"
                        title="Interest and fees on this account's statements, last 12 months"
                      >
                        paid {moneyCents(f.interest_12m)} last 12 mo
                      </div>
                    )}
                  </td>
                  <td className="num">{f.payment ? money(f.payment) : "–"}</td>
                  <td className="small">
                    <PaymentStatus s={f.last_statement} />
                  </td>
                  <td>
                    {f.payoff_date ? (
                      `${monthLabel(f.payoff_date, true)} (${f.payoff_months} mo)`
                    ) : f.type === "credit" && f.last_statement?.status === "paid_in_full" ? (
                      <span className="muted">Paid monthly</span>
                    ) : (
                      <span className="muted">Add rate & payment</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {d.length > 1 && (
          <p
            className="small muted"
            style={{
              padding: "4px 18px 14px",
              margin: 0,
            }}
          >
            Highest rate first: {d.map((f) => `${f.name} (${f.interest_rate}%)`).join(" → ")}. Any extra payment goes
            furthest on the first one; together these balances cost about {money(c)} a year in interest at today's
            rates.
          </p>
        )}
      </section>
    </>
  );
}

function PaymentStatus({ s }) {
  if (s) {
    if (s.status === "nothing_owed") {
      return <span className="muted">Nothing owed</span>;
    } else if (s.status === "installment") {
      return (
        <span>
          Paid {moneyCents(s.paid)}
          {s.interest > 0 && <div className="small muted">{moneyCents(s.interest)} interest</div>}
        </span>
      );
    } else if (s.status === "paid_in_full") {
      return (
        <span
          className="up-good"
          title={`Owed ${moneyCents(s.previous_balance)} at the start, paid ${moneyCents(s.paid)}`}
        >
          ✓ Paid in full
          {s.interest > 0 && (
            <div className="small muted">{moneyCents(s.interest)} interest from an earlier balance</div>
          )}
        </span>
      );
    } else {
      return (
        <span
          className="up-bad"
          title={`Owed ${moneyCents(s.previous_balance)} at the start, paid ${moneyCents(s.paid)}`}
        >
          Carried {moneyCents(s.carried)}
          {s.interest > 0 && <div className="small">{moneyCents(s.interest)} interest charged</div>}
        </span>
      );
    }
  } else {
    return <span className="muted">–</span>;
  }
}
