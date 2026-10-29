import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltip, Legend, axisProps, colorMap, gridProps, yAxisProps } from "../components/charts";
import { Card, Empty, Loading, PageHead, Stat } from "../components/ui";
import { useApi } from "../context";
import { money, monthLabel } from "../format";

const NETWORTH_GROUPS = ["Chequing", "Savings", "TFSA", "RRSP", "FHSA", "Non-registered", "Other assets"];

export function NetWorthPage({ go }) {
  const { data, error } = useApi("/networth");
  if (!data) {
    return <Loading error={error} />;
  }
  if (!data.now.items.length) {
    return (
      <>
        <PageHead title="Net worth" />
        <Empty title="No balances yet">
          Statements give each account a balance. You can also add your home, car or other assets by hand.
          <p>
            <button className="btn primary" onClick={() => go("accounts")}>
              Add assets or debts
            </button>
          </p>
        </Empty>
      </>
    );
  }
  const r = NETWORTH_GROUPS.filter((l) => data.series.some((c) => (c.groups[l] ?? 0) > 0));
  const a = colorMap(r);
  const i = data.series.map((l) => ({
    month: l.month,
    ...Object.fromEntries(r.map((c) => [c, Math.max(l.groups[c] ?? 0, 0)])),
    assets: l.assets,
    liabilities: -l.liabilities,
    net_worth: l.net_worth,
  }));
  const o = data.series.find((l) => l.net_worth !== 0);
  const u = data.series[data.series.length - 1];
  return (
    <>
      <PageHead title="Net worth" sub="Everything you own minus everything you owe, at each month end." />
      <div className="grid g4">
        <Stat hero={true} label="Net worth" value={data.now.net_worth} />
        <Stat label="Assets" value={data.now.assets} />
        <Stat label="Debts" value={data.now.liabilities} />
        <Stat
          label={o ? `Change since ${monthLabel(o.month, true)}` : "Change"}
          value={o && u ? u.net_worth - o.net_worth : null}
          format={(l) => `${l >= 0 ? "+" : "−"}${money(Math.abs(l))}`}
        />
      </div>
      <Card
        title="Net worth over time"
        style={{
          marginTop: 16,
        }}
      >
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart
            data={i}
            margin={{
              top: 8,
              right: 8,
              left: 0,
              bottom: 0,
            }}
            stackOffset="sign"
            barCategoryGap="35%"
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
            <Bar
              dataKey="assets"
              name="Assets"
              fill="var(--s1)"
              stackId="a"
              radius={[4, 4, 0, 0]}
              maxBarSize={24}
              fillOpacity={0.35}
            />
            <Bar
              dataKey="liabilities"
              name="Debts"
              fill="var(--s8)"
              stackId="a"
              radius={[4, 4, 0, 0]}
              maxBarSize={24}
              fillOpacity={0.35}
            />
            <Line
              dataKey="net_worth"
              name="Net worth"
              stroke="var(--ink)"
              strokeWidth={2}
              dot={{
                r: 3,
                fill: "var(--ink)",
                stroke: "var(--surface)",
                strokeWidth: 2,
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <Legend
          items={[
            {
              name: "Assets",
              color: "var(--s1)",
            },
            {
              name: "Debts",
              color: "var(--s8)",
            },
            {
              name: "Net worth",
              color: "var(--ink)",
            },
          ]}
        />
      </Card>
      <Card
        title="What your assets are made of"
        style={{
          marginTop: 16,
        }}
      >
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart
            data={i}
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
            <Tooltip content={<ChartTooltip total={true} reverse={true} labelFormat={(l) => monthLabel(l, true)} />} />
            {r.map((l) => (
              <Area
                type="monotone"
                dataKey={l}
                name={l}
                stackId="1"
                stroke={a[l]}
                strokeWidth={2}
                fill={a[l]}
                fillOpacity={0.18}
                key={l}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
        <Legend
          items={r.map((l) => ({
            name: l,
            color: a[l],
          }))}
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
          <h2>Balance sheet</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Institution</th>
              <th>As of</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {data.now.items
              .filter((l) => l.side === "asset")
              .map((l) => (
                <tr key={`a-${l.account_id}-${l.name}`}>
                  <td>{l.name}</td>
                  <td className="muted">{l.institution}</td>
                  <td className="muted">{l.as_of}</td>
                  <td className="num">{money(l.balance)}</td>
                </tr>
              ))}
            <tr>
              <td
                colSpan={3}
                style={{
                  fontWeight: 600,
                }}
              >
                Total assets
              </td>
              <td
                className="num"
                style={{
                  fontWeight: 600,
                }}
              >
                {money(data.now.assets)}
              </td>
            </tr>
            {data.now.items
              .filter((l) => l.side === "liability")
              .map((l) => (
                <tr key={`l-${l.account_id}-${l.name}`}>
                  <td>{l.name}</td>
                  <td className="muted">{l.institution}</td>
                  <td className="muted">{l.as_of}</td>
                  <td className="num up-bad">−{money(l.balance)}</td>
                </tr>
              ))}
            <tr>
              <td
                colSpan={3}
                style={{
                  fontWeight: 600,
                }}
              >
                Net worth
              </td>
              <td
                className="num"
                style={{
                  fontWeight: 650,
                }}
              >
                {money(data.now.net_worth)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
