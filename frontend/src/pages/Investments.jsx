import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarList, ChartTooltip, Legend, axisProps, colorMap, gridProps, yAxisProps } from "../components/charts";
import { Card, Empty, Loading, PageHead, Stat } from "../components/ui";
import { useApi } from "../context";
import { dayLabel, money, monthLabel, pct } from "../format";

const REGISTRATIONS = ["TFSA", "RRSP", "FHSA", "Non-registered"];

export function InvestmentsPage({ go }) {
  var p;
  const { data, error } = useApi("/investments");
  if (!data) {
    return <Loading error={error} />;
  }
  if (!data.accounts.length) {
    return (
      <>
        <PageHead title="Investments" />
        <Empty title="No investment accounts yet">
          Add Wealthsimple, Questrade or bank brokerage statements, or enter balances by hand.
          <p>
            <button className="btn primary" onClick={() => go("accounts")}>
              Accounts & assets
            </button>
          </p>
        </Empty>
      </>
    );
  }
  const r = data.accounts.reduce((h, y) => h + (y.balance ?? 0), 0);
  const a = data.accounts.reduce((h, y) => h + (y.book_value ?? 0), 0);
  const i = data.accounts.filter((h) => h.balance != null);
  const o = data.accounts.length - i.length;
  const u = i.length > 0 && i.every((h) => h.book_value != null) && a > 0;
  const l = REGISTRATIONS.filter((h) => data.series.some((y) => Number(y[h] ?? 0) > 0));
  const c = colorMap(l);
  const d = {};
  for (const h of data.contributions) {
    const y =
      {
        TFSA: "TFSA",
        RRSP: "RRSP",
        FHSA: "FHSA",
      }[h.registration] ?? "Non-registered";
    d[(p = h.month)] ??
      (d[p] = {
        month: h.month,
      });
    d[h.month][y] = Number(d[h.month][y] ?? 0) + h.amount;
  }
  const f = Object.values(d).sort((h, y) => String(h.month).localeCompare(String(y.month)));
  return (
    <>
      <PageHead title="Investments" sub="Market values from your latest statements." />
      <div className="grid g4">
        <Stat hero={true} label="Invested" value={r} />
        <Stat label="Book value (what you put in)" value={u ? a : null} />
        <Stat
          label="Gain / loss"
          value={u ? r - a : null}
          format={(h) => `${h >= 0 ? "+" : "−"}${money(Math.abs(h))}${a ? ` · ${pct(h / a, 1)}` : ""}`}
        />
        <Stat
          label="Accounts"
          value={data.accounts.length}
          format={(h) => `${h}${o ? ` (${o} without a balance)` : ""}`}
        />
      </div>
      {data.this_year.accounts.length > 0 && <YearToDate y={data.this_year} />}
      <div
        className="grid g3"
        style={{
          marginTop: 16,
        }}
      >
        <Card title="Value over time" className="span2">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart
              data={data.series}
              margin={{
                top: 8,
                right: 8,
                left: 0,
                bottom: 0,
              }}
            >
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="month" tickFormatter={(h) => monthLabel(h)} {...axisProps} />
              <YAxis {...yAxisProps} />
              <Tooltip
                content={<ChartTooltip total={true} reverse={true} labelFormat={(h) => monthLabel(h, true)} />}
              />
              {l.map((h) => (
                <Area
                  type="monotone"
                  dataKey={h}
                  name={h}
                  stackId="1"
                  stroke={c[h]}
                  strokeWidth={2}
                  fill={c[h]}
                  fillOpacity={0.18}
                  dot={{
                    r: 4,
                    fill: c[h],
                    stroke: "var(--surface)",
                    strokeWidth: 2,
                  }}
                  connectNulls={true}
                  key={h}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          <Legend
            items={l.map((h) => ({
              name: h,
              color: c[h],
            }))}
          />
        </Card>
        <Card title="By account type">
          <BarList
            rows={data.by_registration.map((h) => ({
              name: h.name,
              value: h.market_value,
              note: h.book_value ? `book ${money(h.book_value)}` : undefined,
            }))}
          />
        </Card>
      </div>
      <div
        className="grid g2"
        style={{
          marginTop: 16,
        }}
      >
        <Card
          title={`Contribution room · ${new Date().getFullYear()}`}
          extra={
            <button className="btn small" onClick={() => go("accounts")}>
              Edit room
            </button>
          }
        >
          {data.room.length === 0 ? (
            <p className="muted">
              Enter your TFSA / RRSP / FHSA room (from CRA My Account or your Notice of Assessment) on the Accounts page
              to track it here.
            </p>
          ) : (
            <div
              className="stack"
              style={{
                gap: 14,
              }}
            >
              {data.room.map((h) => {
                var y;
                return (
                  <div key={`${h.member_id}-${h.registration}`}>
                    <div
                      className="row"
                      style={{
                        justifyContent: "space-between",
                      }}
                    >
                      <strong>
                        {new Set(data.room.map((b) => b.member_id)).size > 1 ? `${h.member} · ` : ""}
                        {h.registration}
                      </strong>
                      <span className={h.remaining < 0 ? "up-bad" : "muted"}>
                        {money(h.contributed)} of {money(h.room)} used ·{" "}
                        {h.remaining >= 0 ? `${money(h.remaining)} left` : `over by ${money(-h.remaining)}`}
                      </span>
                    </div>
                    <div
                      className="meter"
                      style={{
                        marginTop: 6,
                      }}
                      role="meter"
                      aria-valuenow={h.contributed}
                      aria-valuemax={h.room}
                      aria-label={`${h.registration} room used`}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, (h.contributed / Math.max(h.room, 1)) * 100)}%`,
                          background:
                            h.remaining < 0
                              ? "var(--critical)"
                              : h.remaining < h.room * 0.1
                                ? "var(--warning)"
                                : undefined,
                        }}
                      />
                    </div>
                    {h.basis === "estimate" ? (
                      <div className="small muted">
                        Estimate: yearly limits since you became eligible, minus the book value of your {h.registration}{" "}
                        accounts.{(y = h.notes) != null && y.length ? ` ${h.notes[0]}.` : ""}
                      </div>
                    ) : (
                      h.detected && (
                        <div className="small muted">
                          This year's contributions, found in your statements. You can type your own on Accounts &
                          assets.
                        </div>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
        <Card title="Contributions by month">
          {f.length === 0 ? (
            <p className="muted">No contributions found in investment statements yet.</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={f}
                  margin={{
                    top: 8,
                    right: 8,
                    left: 0,
                    bottom: 0,
                  }}
                  barCategoryGap="30%"
                >
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="month" tickFormatter={(h) => monthLabel(h)} {...axisProps} />
                  <YAxis {...yAxisProps} />
                  <Tooltip
                    cursor={{
                      fill: "var(--surface-2)",
                    }}
                    content={<ChartTooltip total={true} labelFormat={(h) => monthLabel(h, true)} />}
                  />
                  {REGISTRATIONS.filter((h) => f.some((y) => y[h])).map((h) => (
                    <Bar
                      dataKey={h}
                      name={h}
                      stackId="c"
                      fill={c[h] ?? "var(--s1)"}
                      stroke="var(--surface)"
                      strokeWidth={1}
                      maxBarSize={24}
                      key={h}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </>
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
          <h2>Accounts</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Type</th>
              <th>As of</th>
              <th className="num">Book value</th>
              <th className="num">Market value</th>
              <th className="num">Gain</th>
              <th className="num">Return</th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((h) => (
              <tr key={h.account_id ?? h.name}>
                <td>{h.name}</td>
                <td className="muted">{h.registration === "NONREG" ? "Non-registered" : h.registration}</td>
                <td className="muted">{h.as_of ?? <span className="badge">no balance yet</span>}</td>
                <td className="num">{money(h.book_value)}</td>
                <td className="num">{money(h.balance)}</td>
                <td
                  className={`num ${h.book_value && h.balance != null ? (h.balance >= h.book_value ? "up-good" : "up-bad") : "muted"}`}
                >
                  {h.book_value && h.balance != null
                    ? `${h.balance >= h.book_value ? "+" : "−"}${money(Math.abs(h.balance - h.book_value))}`
                    : "–"}
                </td>
                <td
                  className={`num ${h.book_value && h.balance != null ? (h.balance >= h.book_value ? "up-good" : "up-bad") : "muted"}`}
                >
                  {h.book_value && h.balance != null ? pct((h.balance - h.book_value) / h.book_value, 1) : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.holdings.length > 0 && (
          <>
            <div
              style={{
                padding: "14px 18px 4px",
              }}
            >
              <h2>Holdings</h2>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Account</th>
                  <th className="num">Units</th>
                  <th className="num">Market value</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.map((h, y) => (
                  <tr key={y}>
                    <td>{h.symbol}</td>
                    <td className="muted">{h.account}</td>
                    <td className="num">{h.units ?? "–"}</td>
                    <td className="num">{money(h.market_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </>
  );
}

function YearToDate({ y }) {
  const t = y.value - y.start;
  const n = y.since.endsWith("-01-01");
  const r = (a) => `${a >= 0 ? "+" : "−"}${money(Math.abs(a))}`;
  return (
    <Card
      title={n ? `${y.year} so far` : `Since ${dayLabel(y.since)}`}
      style={{
        marginTop: 16,
      }}
    >
      <div
        className="grid g4"
        style={{
          gap: 12,
        }}
      >
        <div>
          <div className="small muted">{n ? "Jan 1 value" : `Value on ${dayLabel(y.since)}`}</div>
          <div className="big-num">{money(y.start)}</div>
        </div>
        <div>
          <div className="small muted">You put in</div>
          <div className="big-num">{r(y.put_in)}</div>
        </div>
        <div>
          <div className="small muted">Market growth</div>
          <div className={`big-num ${y.growth >= 0 ? "up-good" : "up-bad"}`}>
            {r(y.growth)}
            {y.growth_pct != null && <span className="small"> · ≈{pct(y.growth_pct, 1)}</span>}
          </div>
        </div>
        <div>
          <div className="small muted">Value now</div>
          <div className="big-num">
            {money(y.value)} <span className="small muted">({r(t)})</span>
          </div>
        </div>
      </div>
      <p
        className="small muted"
        style={{
          margin: "10px 0 0",
        }}
      >
        "Put in" is the change in book value (contributions minus withdrawals); market growth is everything else (gains,
        dividends, interest, fees).
        {!n && (
          <>
            {" "}
            Measured from the first balance this year
            {y.accounts.length > 1 ? " (the latest start among your accounts)" : ""}; add a January balance on Accounts
            & assets to see the whole year.
          </>
        )}
        {y.missing.length > 0 && (
          <> Not included, no book value: {y.missing.join(", ")}. Add it with Update balance on Accounts & assets.</>
        )}
      </p>
    </Card>
  );
}
