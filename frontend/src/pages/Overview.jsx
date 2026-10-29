import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CheckBanner } from "../components/Checks";
import { BarList, ChartTooltip, Legend, axisProps, gridProps, yAxisProps } from "../components/charts";
import { Card, Empty, Loading, PageHead, Stat } from "../components/ui";
import { useApi } from "../context";
import { dayLabel, money, moneyCents, monthLabel, pct } from "../format";

export function OverviewPage({ go }) {
  const { data, error } = useApi("/overview");
  const r = useApi("/upcoming?days=30");
  if (!data) {
    return <Loading error={error} />;
  }
  if (!data.accounts.length && !data.cashflow.length) {
    return (
      <>
        <PageHead title="Overview" />
        <Empty title="No data yet">
          <p>
            Drop your bank, credit card and investment statements (PDF) anywhere on this window,
            <br />
            or copy them into the <code>statements</code> folder and reopen the dashboard.
          </p>
          <p
            className="row"
            style={{
              justifyContent: "center",
            }}
          >
            <button className="btn primary" onClick={() => go("inbox")}>
              Add statements
            </button>
            <button className="btn" onClick={() => go("accounts")}>
              Enter balances by hand
            </button>
          </p>
        </Empty>
      </>
    );
  }
  const a = data.month;
  const i = a
    ? Object.entries(a.by_category)
        .sort((l, c) => c[1] - l[1])
        .slice(0, 6)
    : [];
  const o = data.cashflow;
  const u = data.accounts.filter((l) => l.stale);
  return (
    <>
      <PageHead title="Overview" sub={`Balances as of the latest statement for each account · ${data.as_of}`} />
      <CheckBanner go={go} />
      <div className="grid g4">
        <Stat
          hero={true}
          label="Net worth"
          value={data.net_worth}
          delta={data.net_worth_change}
          deltaLabel="vs last month"
        />
        <Stat label="Assets" value={data.assets} />
        <Stat label="Debts" value={data.liabilities} />
        <Stat
          label={a ? `Saved in ${monthLabel(data.latest_month, true)}` : "Saved this month"}
          sub={a ? "latest complete month" : undefined}
          value={a?.net}
          format={(l) => `${money(l)}${a?.savings_rate != null ? ` · ${pct(a.savings_rate)}` : ""}`}
        />
      </div>
      <div
        className="grid g3"
        style={{
          marginTop: 16,
        }}
      >
        <Card
          title="Net worth"
          className="span2"
          extra={
            <button className="btn small" onClick={() => go("networth")}>
              Details
            </button>
          }
        >
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart
              data={data.networth}
              margin={{
                top: 8,
                right: 8,
                left: 0,
                bottom: 0,
              }}
            >
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="month" tickFormatter={(l) => monthLabel(l)} {...axisProps} />
              <YAxis {...yAxisProps} />
              <Tooltip content={<ChartTooltip labelFormat={(l) => monthLabel(l, true)} />} />
              <Area
                type="monotone"
                dataKey="net_worth"
                name="Net worth"
                stroke="var(--s1)"
                strokeWidth={2}
                fill="var(--s1)"
                fillOpacity={0.1}
                activeDot={{
                  r: 5,
                  stroke: "var(--surface)",
                  strokeWidth: 2,
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Where your assets are">
          {data.allocation.length ? (
            <BarList
              rows={data.allocation.map((l) => ({
                name: l.name,
                value: l.value,
              }))}
            />
          ) : (
            <p className="muted">No asset balances yet.</p>
          )}
          {data.liabilities > 0 && (
            <>
              <h3
                style={{
                  marginTop: 18,
                }}
              >
                Owed
              </h3>
              <BarList
                color="var(--s8)"
                rows={data.accounts
                  .filter((l) => l.side === "liability")
                  .map((l) => ({
                    name: l.name,
                    value: l.balance,
                  }))}
              />
            </>
          )}
        </Card>
      </div>
      <div
        className="grid g3"
        style={{
          marginTop: 16,
        }}
      >
        <Card
          title="Income vs spending"
          className="span2"
          extra={
            <button className="btn small" onClick={() => go("review")}>
              Monthly review
            </button>
          }
        >
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={o}
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
              <XAxis dataKey="month" tickFormatter={(l) => monthLabel(l)} {...axisProps} />
              <YAxis {...yAxisProps} />
              <Tooltip
                cursor={{
                  fill: "var(--surface-2)",
                }}
                content={<ChartTooltip labelFormat={(l) => monthLabel(l, true)} />}
              />
              <Bar dataKey="income" name="Income" fill="var(--s1)" radius={[4, 4, 0, 0]} maxBarSize={24}>
                {o.map((l) => (
                  <Cell fillOpacity={l.partial ? 0.35 : 1} key={l.month} />
                ))}
              </Bar>
              <Bar dataKey="expenses" name="Spending" fill="var(--s2)" radius={[4, 4, 0, 0]} maxBarSize={24}>
                {o.map((l) => (
                  <Cell fillOpacity={l.partial ? 0.35 : 1} key={l.month} />
                ))}
              </Bar>
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
          {o.some((l) => l.partial) && (
            <p
              className="small muted"
              style={{
                margin: "4px 0 0",
              }}
            >
              Faded bars:{" "}
              {o
                .filter((l) => l.partial)
                .map((l) => monthLabel(l.month, true))
                .join(", ")}{" "}
              still waiting for some statements.
            </p>
          )}
        </Card>
        <Card
          title={a ? `Top spending · ${monthLabel(data.latest_month, true)}` : "Top spending"}
          extra={
            <button className="btn small" onClick={() => go("spending")}>
              All
            </button>
          }
        >
          {i.length ? (
            <BarList
              rows={i.map(([l, c]) => ({
                name: l,
                value: c,
              }))}
            />
          ) : (
            <p className="muted">No spending yet.</p>
          )}
          {a && (
            <p
              className="small muted"
              style={{
                marginTop: 14,
              }}
            >
              Essentials {money(a.essential)} · Discretionary {money(a.discretionary)}
            </p>
          )}
        </Card>
      </div>
      {r.data && r.data.items.length > 0 && (
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
            <h2>Coming up in the next {r.data.days} days</h2>
            <span
              className="badge"
              title="Leaving your bank accounts. Bills charged to a card are paid through the card payment, so they aren't added twice."
            >
              {money(r.data.total)} from your bank accounts · regular bills {money(r.data.monthly_total)}/mo
            </span>
          </div>
          <p
            className="small muted"
            style={{
              padding: "0 18px",
              margin: 0,
            }}
          >
            Learned from your statements: charges that came every month for a similar amount around the same day.
            {r.data.on_card_total > 0 && (
              <> Card charges ({money(r.data.on_card_total)}/mo) are shown but counted in the card payment.</>
            )}
          </p>
          <table>
            <tbody>
              {r.data.items.map((l) => (
                <tr key={l.merchant}>
                  <td
                    className="small"
                    style={{
                      whiteSpace: "nowrap",
                      width: 90,
                    }}
                  >
                    {l.not_seen_yet ? (
                      <span className="badge warn" title="Expected by now but not in your statements yet">
                        due {dayLabel(l.next_date)}
                      </span>
                    ) : (
                      <>
                        {dayLabel(l.next_date)}
                        <div className="muted">{l.days_away === 0 ? "today" : `in ${l.days_away} days`}</div>
                      </>
                    )}
                  </td>
                  <td>
                    {l.merchant}
                    <div className="small muted">
                      {l.category}
                      {l.account ? ` · ${l.account}` : ""}
                      {l.member && data.accounts.some((c) => c.member && c.member !== l.member) ? ` · ${l.member}` : ""}
                    </div>
                  </td>
                  <td className={`num ${l.on_card ? "muted" : ""}`}>
                    {moneyCents(l.amount)}
                    {l.on_card && <div className="small">on card</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
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
          <h2>Accounts</h2>
          {u.length > 0 && (
            <button
              className="btn small"
              onClick={() => go("accounts")}
              title={`Balances older than ${data.stale_days} days`}
            >
              {u.length} out-of-date balance{u.length > 1 ? "s" : ""}: update
            </button>
          )}
        </div>
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Type</th>
              <th>As of</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((l) => (
              <tr key={`${l.account_id}-${l.name}`}>
                <td>{l.name}</td>
                <td className="muted">
                  {l.registration && l.registration !== "NONREG" ? `${l.registration} · ` : ""}
                  {l.type}
                </td>
                <td className="muted">
                  {l.as_of}
                  {l.stale && (
                    <span
                      className="badge stale"
                      style={{
                        marginLeft: 6,
                      }}
                      title={`Older than ${data.stale_days} days: net worth may be off`}
                    >
                      out of date
                    </span>
                  )}
                </td>
                <td className={`num ${l.side === "liability" ? "up-bad" : ""}`}>
                  {l.side === "liability" ? `−${money(l.balance)}` : money(l.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
