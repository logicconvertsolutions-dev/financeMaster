import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip, Legend, Sparkline, axisProps, gridProps, yAxisProps } from "../components/charts";
import { Alert, Card, Empty, Loading, PageHead, Stat } from "../components/ui";
import { useApi } from "../context";
import { money, moneyCents, monthLabel, pct, signedMoney } from "../format";

const CUT_KINDS = {
  baseline: "Above your usual",
  budget: "Over budget",
  subscription: "Subscription",
  fee: "Avoidable fee",
  habit: "Habit",
};

const SUB_STATUS = {
  new: "🆕 New",
  price_up: "⬆ Price up",
  active: "Active",
};

export function ReviewPage({ go }) {
  const [t, n] = useState(null);
  const { data, error } = useApi(`/review${t ? `?month=${t}` : ""}`);
  if (!data) {
    return <Loading error={error} />;
  }
  if (data.empty) {
    return (
      <>
        <PageHead title="Monthly review" />
        <Empty title="Nothing to review yet">
          Import at least one month of chequing or credit card statements. Comparisons start from the second month.
          <p>
            <button className="btn primary" onClick={() => go("inbox")}>
              Add statements
            </button>
          </p>
        </Empty>
      </>
    );
  }
  const i = data.scorecard;
  const o = data.months_available.indexOf(data.month);
  const u = data.baseline_months.length > 0;
  const l = u ? `${data.baseline_months.length}-month average` : "";
  const c = data.categories.filter((h) => h.kind === "essential" || h.kind === "discretionary");
  const d = data.partial;
  const f = new Set(data.complete_months);
  return (
    <>
      <PageHead
        title={
          <>
            Monthly review · {monthLabel(data.month, true)}
            {d && (
              <span
                className="badge warn"
                style={{
                  marginLeft: 8,
                  verticalAlign: "middle",
                }}
              >
                so far
              </span>
            )}
          </>
        }
        sub={
          u
            ? `Compared with last month and your ${l} (${data.baseline_months.map((h) => monthLabel(h)).join(", ")})`
            : "This is your first month. Comparisons appear once next month's statements are in."
        }
      >
        <button
          className="btn"
          disabled={o <= 0}
          onClick={() => n(data.months_available[o - 1])}
          aria-label="Previous month"
        >
          ‹
        </button>
        <select value={data.month} onChange={(h) => n(h.target.value)} aria-label="Month">
          {[...data.months_available].reverse().map((h) => (
            <option value={h} key={h}>
              {monthLabel(h, true)}
              {f.has(h) ? "" : " (incomplete)"}
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={o >= data.months_available.length - 1}
          onClick={() => n(data.months_available[o + 1])}
          aria-label="Next month"
        >
          ›
        </button>
      </PageHead>
      {d && (
        <div
          className="notice"
          style={{
            marginBottom: 12,
          }}
        >
          <strong>This month isn't complete yet.</strong>{" "}
          {data.coverage.missing.length > 0 ? (
            <>Still waiting for statements covering all of it from {data.coverage.missing.join(", ")}. </>
          ) : null}
          Figures are "so far", and comparisons that need the whole month (income, savings rate, "less than usual") are
          held back.
        </div>
      )}
      <div className="grid g4">
        <Stat
          label={d ? "Income so far" : "Income"}
          value={i.income}
          delta={i.prev && !d ? i.income - i.prev.income : undefined}
          deltaLabel="vs last month"
        />
        <Stat
          label={d ? "Spending so far" : "Spending"}
          value={i.expenses}
          goodWhenUp={false}
          delta={i.prev && !d ? i.expenses - i.prev.expenses : undefined}
          deltaLabel="vs last month"
        />
        <Stat
          label="Savings rate"
          value={d ? null : i.savings_rate}
          format={(h) => pct(h)}
          minDelta={0.005}
          deltaFormat={(h) => `${Math.round(h * 100)} pts`}
          delta={
            !d && i.prev?.savings_rate != null && i.savings_rate != null
              ? i.savings_rate - i.prev.savings_rate
              : undefined
          }
          deltaLabel="vs last month"
        />
        <Stat label="Net worth change" value={i.net_worth_change} format={signedMoney} />
      </div>
      {data.people && data.people.length > 1 && (
        <section
          className="card flush"
          style={{
            marginTop: 16,
          }}
        >
          <div
            style={{
              padding: "12px 18px 2px",
            }}
            className="card-head"
          >
            <h2>By person</h2>
            <button className="btn small" onClick={() => go("family")}>
              Compare on Family page
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th className="num">Income</th>
                <th className="num">Spending</th>
                <th className="num">Savings rate</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.people.map((h) => (
                <tr key={h.name}>
                  <td>
                    <i
                      className="member-dot"
                      style={{
                        background: h.color ?? "var(--other)",
                      }}
                    />
                    {h.name}
                  </td>
                  <td className="num">{money(h.income)}</td>
                  <td className="num">{money(h.expenses)}</td>
                  <td className="num">{pct(h.savings_rate)}</td>
                  <td className="small muted">{h.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <div
        className="grid g2"
        style={{
          marginTop: 16,
        }}
      >
        <Card
          title="Suggested cutdowns"
          extra={
            data.potential_monthly_savings > 0 && (
              <span className="badge">
                up to {money(data.potential_monthly_savings)}/mo · {money(data.potential_monthly_savings * 12)}/yr
              </span>
            )
          }
        >
          {data.cutdowns.length === 0 ? (
            <p className="muted">
              {u
                ? "Nothing stands out this month. Spending is in line with your usual."
                : "Suggestions start once there's a month to compare against."}
            </p>
          ) : (
            data.cutdowns.map((h) => (
              <div className="cut" key={h.title}>
                <div>
                  <span
                    className="badge"
                    style={{
                      marginBottom: 4,
                    }}
                  >
                    {CUT_KINDS[h.type] ?? h.type}
                  </span>
                  <div
                    style={{
                      fontWeight: 600,
                    }}
                  >
                    {h.title}
                  </div>
                  <div className="muted small">{h.detail}</div>
                </div>
                {h.one_off ? (
                  <div>
                    <div className="save muted">{money(h.monthly_saving)}</div>
                    <div className="yr">one-time</div>
                  </div>
                ) : (
                  <div>
                    <div className="save">{money(h.monthly_saving)}/mo</div>
                    <div className="yr">{money(h.yearly_saving)}/yr</div>
                  </div>
                )}
              </div>
            ))
          )}
          <p
            className="small muted"
            style={{
              marginTop: 8,
            }}
          >
            Estimates from your own history. Only discretionary spending and avoidable fees are suggested; one-off
            purchases aren't counted in the total.
          </p>
        </Card>
        <Card title="Feedback">
          <div
            className="stack"
            style={{
              gap: 8,
            }}
          >
            {data.alerts.length ? (
              data.alerts.map((h, y) => <Alert {...h} key={y} />)
            ) : (
              <p className="muted">No alerts this month.</p>
            )}
          </div>
          {data.family_transfers && data.family_transfers.items.length > 0 && <FamilyFlows f={data.family_transfers} />}
        </Card>
      </div>
      <div
        className="grid g2"
        style={{
          marginTop: 16,
        }}
      >
        <Card title="Spending more than usual">
          {data.increases.length === 0 ? (
            <p className="muted">{u ? "No category is up meaningfully." : "–"}</p>
          ) : (
            <table>
              <tbody>
                {data.increases.map((h) => (
                  <tr key={h.category}>
                    <td>
                      <div
                        style={{
                          fontWeight: 600,
                        }}
                      >
                        {h.category}
                      </div>
                      {h.detail && <div className="small muted">{h.detail}</div>}
                    </td>
                    <td className="num">
                      {money(h.this)}
                      <div className="small muted">avg {money(h.avg3)}</div>
                    </td>
                    <td className="num up-bad">
                      ▲ {money(h.delta)}
                      <div className="small">{h.pct != null ? `+${pct(h.pct)}` : "new"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Wins: spending less than usual">
          {data.decreases.length === 0 ? (
            <p className="muted">
              {d
                ? "Shown once the month's statements are all in."
                : u
                  ? "No category dropped meaningfully this month."
                  : "–"}
            </p>
          ) : (
            <table>
              <tbody>
                {data.decreases.map((h) => (
                  <tr key={h.category}>
                    <td
                      style={{
                        fontWeight: 600,
                      }}
                    >
                      {h.category}
                    </td>
                    <td className="num">
                      {money(h.this)}
                      <div className="small muted">avg {money(h.avg3)}</div>
                    </td>
                    <td className="num up-good">
                      ▼ {money(-(h.delta ?? 0))}
                      <div className="small">saved vs usual</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card
        title="Income and spending, last 12 months"
        style={{
          marginTop: 16,
        }}
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={data.trend}
            margin={{
              top: 8,
              right: 8,
              left: 0,
              bottom: 0,
            }}
            barGap={2}
            barCategoryGap="30%"
          >
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="month" tickFormatter={(h) => monthLabel(h)} {...axisProps} />
            <YAxis {...yAxisProps} />
            <Tooltip
              cursor={{
                fill: "var(--surface-2)",
              }}
              content={<ChartTooltip labelFormat={(h) => monthLabel(h, true)} />}
            />
            <Bar dataKey="income" name="Income" fill="var(--s1)" radius={[4, 4, 0, 0]} maxBarSize={24} />
            <Bar dataKey="expenses" name="Spending" fill="var(--s2)" radius={[4, 4, 0, 0]} maxBarSize={24} />
          </BarChart>
        </ResponsiveContainer>
        <Legend
          items={[
            {
              name: "Income",
              color: "var(--s1)",
            },
            {
              name: "Spending",
              color: "var(--s2)",
            },
          ]}
        />
      </Card>
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
          <h2>Spending by category</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Type</th>
                <th className="num">This month</th>
                <th className="num">Last month</th>
                <th className="num">{u ? l : "Average"}</th>
                <th className="num">vs average</th>
                <th>Last 6 months</th>
              </tr>
            </thead>
            <tbody>
              {c.map((h) => {
                const y = h.delta != null && h.avg3 != null && Math.abs(h.delta) >= Math.max(50, h.avg3 * 0.25);
                return (
                  <tr
                    style={{
                      cursor: "pointer",
                    }}
                    onClick={() => go(`spending?category=${encodeURIComponent(h.category)}&month=${data.month}`)}
                    key={h.category}
                  >
                    <td>
                      {h.category}
                      {h.budget ? <span className="muted small"> · budget {money(h.budget)}</span> : null}
                    </td>
                    <td className="muted small">{h.kind}</td>
                    <td className="num">{money(h.this)}</td>
                    <td className="num muted">{money(h.last)}</td>
                    <td className="num muted">{money(h.avg3)}</td>
                    <td className={`num ${y ? (h.delta > 0 ? "up-bad" : "up-good") : "muted"}`}>
                      {h.delta == null
                        ? "–"
                        : `${h.delta > 0 ? "▲" : h.delta < 0 ? "▼" : ""} ${money(Math.abs(h.delta))}${h.pct != null ? ` (${h.pct > 0 ? "+" : ""}${pct(h.pct)})` : ""}`}
                    </td>
                    <td>
                      <Sparkline values={data.category_trend[h.category] ?? []} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
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
          <h2>Recurring charges and subscriptions</h2>
          <span className="badge">
            {moneyCents(data.subscriptions.reduce((h, y) => h + y.amount, 0))}/mo ·{" "}
            {money(data.subscriptions.reduce((h, y) => h + y.annual, 0))}/yr
          </span>
        </div>
        {data.subscriptions.length === 0 ? (
          <p
            className="muted"
            style={{
              padding: "0 18px 14px",
            }}
          >
            No recurring charges detected yet (needs 2+ months).
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Category</th>
                <th>Status</th>
                <th className="num">Monthly</th>
                <th className="num">Yearly</th>
              </tr>
            </thead>
            <tbody>
              {data.subscriptions.map((h) => (
                <tr key={h.merchant}>
                  <td>
                    {h.merchant}
                    {!h.charged_this_month && <span className="muted small"> · not charged this month</span>}
                  </td>
                  <td className="muted">{h.category}</td>
                  <td>
                    {h.status === "active" ? (
                      <span className="muted">Active</span>
                    ) : (
                      <span className="badge">
                        {SUB_STATUS[h.status]}
                        {h.previous_amount ? ` from ${moneyCents(h.previous_amount)}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="num">{moneyCents(h.amount)}</td>
                  <td className="num">{money(h.annual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function FamilyFlows({ f }) {
  const t = [...new Set(f.items.map((n) => n.counterpart).filter(Boolean))];
  return (
    <div
      style={{
        marginTop: 14,
        borderTop: "1px solid var(--border)",
        paddingTop: 12,
      }}
    >
      <h3
        style={{
          marginBottom: 4,
        }}
      >
        Money between family members
      </h3>
      <p
        className="small muted"
        style={{
          marginTop: 0,
        }}
      >
        {f.everyone
          ? "Moved between family members' own accounts. It cancels out, so it isn't counted as anyone's spending or income."
          : "Not counted as spending or income. It's money moving within the family."}
      </p>
      {!f.everyone && (
        <div
          className="row"
          style={{
            gap: 18,
            marginBottom: 6,
          }}
        >
          {f.sent > 0 && (
            <span>
              Sent{t.length ? ` to ${t.join(", ")}` : ""}: <strong>{moneyCents(f.sent)}</strong>
            </span>
          )}
          {f.received > 0 && (
            <span>
              Received{t.length ? ` from ${t.join(", ")}` : ""}: <strong>{moneyCents(f.received)}</strong>
            </span>
          )}
        </div>
      )}
      <table>
        <tbody>
          {f.items.map((n, r) => (
            <tr key={r}>
              <td
                className="muted small"
                style={{
                  whiteSpace: "nowrap",
                }}
              >
                {n.date}
              </td>
              <td className="small">
                {n.description}
                <div className="muted">
                  {n.member}
                  {n.counterpart ? ` → ${n.counterpart}` : ""}
                </div>
              </td>
              <td className={`num small ${n.amount > 0 ? "up-good" : ""}`}>
                {n.amount > 0 ? "+" : ""}
                {moneyCents(n.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
