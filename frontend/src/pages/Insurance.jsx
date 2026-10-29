import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { BarList, ChartTooltip, Legend, axisProps, colorMap, gridProps, yAxisProps } from "../components/charts";
import { Alert, Card, Loading, PageHead, Stat } from "../components/ui";
import { useApi, useApp } from "../context";
import { money, moneyCents, monthLabel } from "../format";

const FREQUENCY = {
  monthly: "month",
  biweekly: "2 weeks",
  quarterly: "quarter",
  semiannual: "6 months",
  annual: "year",
};

const PAID_VIA = {
  bank: "From my bank / card",
  payroll: "Deducted from pay",
  other: "Other",
};

const blankPolicy = (e = "car", t = "", n = "") => ({
  name: "",
  provider: t,
  policy_type: e,
  coverages: [
    {
      type: e,
      amount: null,
      detail: "",
    },
  ],
  premium: null,
  frequency: "monthly",
  paid_via: "bank",
  match_pattern: n,
  insured: "",
  reference: "",
  renewal_date: "",
  notes: "",
  active: 1,
});

export function InsurancePage() {
  const { data, error, reload } = useApi("/insurance");
  const [r, a] = useState(null);
  if (!data) {
    return <Loading error={error} />;
  }
  const i = data.totals;
  const o = colorMap(data.series.slice(0, 8));
  const u = new Set(data.coverage.map((l) => l.type));
  return (
    <>
      <PageHead
        title="Insurance"
        sub="What you're covered for, what it costs, and what your statements show you actually paid."
      >
        <button className="btn primary" onClick={() => a(blankPolicy())}>
          + Add policy
        </button>
      </PageHead>
      <div className="grid g4">
        <Stat hero={true} label="Premiums per year" value={i.annual_premiums} format={money} />
        <Stat label="Paid from bank, last 12 months" value={i.paid_12m} />
        <Stat label="Deducted from pay per year" value={i.payroll_annual} />
        <Stat label="Total life coverage" value={i.life_coverage} />
      </div>
      {r && (
        <PolicyEditor
          p={r}
          data={data}
          onDone={() => {
            a(null);
            reload();
          }}
        />
      )}
      {data.renewals.length > 0 && (
        <div
          className="stack"
          style={{
            gap: 8,
            marginTop: 16,
          }}
        >
          {data.renewals.map((l) => (
            <Alert
              severity="info"
              title={`${l.name} renews ${l.days === 0 ? "today" : `in ${l.days} days`} (${l.date})`}
              detail="A good moment to check the coverage still fits and compare a quote or two before it auto-renews."
              key={l.name}
            />
          ))}
        </div>
      )}
      {data.unassigned.length > 0 && (
        <Card
          title="Insurance payments not linked to a policy"
          style={{
            marginTop: 16,
          }}
          extra={<span className="small muted">{money(i.unassigned_12m)} in the last 12 months</span>}
        >
          <table>
            <tbody>
              {data.unassigned.map((l) => (
                <tr key={l.merchant}>
                  <td>
                    <strong>{l.merchant}</strong>
                    <div className="small muted">{l.example}</div>
                  </td>
                  <td className="num">{l.count}×</td>
                  <td className="num">{moneyCents(l.total)}</td>
                  <td>
                    <button
                      className="btn small"
                      onClick={() =>
                        a({
                          ...blankPolicy("other", l.merchant, l.merchant),
                          name: l.merchant,
                          premium: Math.round((l.total / Math.max(l.count, 1)) * 100) / 100,
                        })
                      }
                    >
                      Add as policy
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <div
        className="grid g3"
        style={{
          marginTop: 16,
        }}
      >
        <Card title="What you pay each month (from statements)" className="span2">
          {data.series.length === 0 ? (
            <p className="muted">
              No insurance payments found in your statements yet. Payments categorized as Insurance, or matching a
              policy's keyword, show up here.
            </p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={data.monthly}
                  margin={{
                    top: 8,
                    right: 8,
                    left: 0,
                    bottom: 0,
                  }}
                  barCategoryGap="30%"
                >
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="month" tickFormatter={(l) => monthLabel(l)} {...axisProps} />
                  <YAxis {...yAxisProps} />
                  <Tooltip
                    cursor={{
                      fill: "var(--surface-2)",
                    }}
                    content={
                      <ChartTooltip
                        total={true}
                        reverse={true}
                        valueFormat={moneyCents}
                        labelFormat={(l) => monthLabel(l, true)}
                      />
                    }
                  />
                  {data.series.slice(0, 8).map((l) => (
                    <Bar
                      dataKey={l}
                      name={l}
                      stackId="i"
                      fill={o[l]}
                      stroke="var(--surface)"
                      strokeWidth={1}
                      maxBarSize={28}
                      key={l}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <Legend
                items={data.series.slice(0, 8).map((l) => ({
                  name: l,
                  color: o[l],
                }))}
              />
            </>
          )}
        </Card>
        <Card title="Premiums per year by type">
          {data.premium_by_type.length ? (
            <BarList rows={data.premium_by_type} />
          ) : (
            <p className="muted">Add your policies to see this.</p>
          )}
        </Card>
      </div>
      <Card
        title="Coverage summary"
        style={{
          marginTop: 16,
        }}
      >
        <table>
          <thead>
            <tr>
              <th>Coverage</th>
              <th className="num">Amount</th>
              <th>Through</th>
            </tr>
          </thead>
          <tbody>
            {data.coverage.map((l) => (
              <tr key={l.type}>
                <td>{l.label}</td>
                <td className="num">{l.amount ? money(l.amount) : <span className="muted">covered</span>}</td>
                <td className="muted">{l.policies.join(", ")}</td>
              </tr>
            ))}
            {["car", "home", "tenant", "life", "health", "dental", "disability", "critical_illness", "travel"]
              .filter((l) => !u.has(l))
              .map((l) => (
                <tr
                  style={{
                    opacity: 0.55,
                  }}
                  key={l}
                >
                  <td>{data.types[l]}</td>
                  <td className="num">–</td>
                  <td className="muted small">nothing recorded</td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="small muted">{`"Nothing recorded" only means no policy with that coverage has been entered here; it's not a recommendation.`}</p>
      </Card>
      <div
        className="stack"
        style={{
          marginTop: 16,
        }}
      >
        {data.policies.length === 0 && !r && (
          <Card title="Your policies">
            <p
              className="muted"
              style={{
                margin: 0,
              }}
            >
              Add each policy: car, home or tenant, life, health and dental (including work benefits deducted from your
              pay), disability, travel, pet… A policy can hold several coverages, e.g. a life policy with
              critical-illness and disability riders, or a work plan with health, dental and life.
            </p>
          </Card>
        )}
        {data.policies.map((l) => {
          return (
            <div
              className="policy"
              style={{
                opacity: l.active ? 1 : 0.55,
              }}
              key={l.id}
            >
              <div
                className="row"
                style={{
                  alignItems: "flex-start",
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minWidth: 220,
                  }}
                >
                  <div
                    className="row"
                    style={{
                      gap: 8,
                    }}
                  >
                    <strong
                      style={{
                        fontSize: 15,
                      }}
                    >
                      {l.name}
                    </strong>
                    <span className="badge">{data.types[l.policy_type]}</span>
                    {!l.active && <span className="badge">inactive</span>}
                  </div>
                  <div className="small muted">
                    {[
                      l.insured_member && `${l.insured_member}'s policy`,
                      l.provider,
                      l.insured && `insured: ${l.insured}`,
                      l.reference && `ref ${l.reference}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div
                    className="chips"
                    style={{
                      marginTop: 8,
                    }}
                  >
                    {l.coverages.map((d, f) => (
                      <span
                        className="chip"
                        style={{
                          cursor: "default",
                        }}
                        key={f}
                      >
                        {data.types[d.type] ?? d.type}
                        {d.amount ? ` · ${money(d.amount)}` : ""}
                        {d.detail ? ` · ${d.detail}` : ""}
                      </span>
                    ))}
                  </div>
                  {l.notes && (
                    <div
                      className="small"
                      style={{
                        marginTop: 6,
                      }}
                    >
                      {l.notes}
                    </div>
                  )}
                </div>
                <div
                  style={{
                    textAlign: "right",
                    minWidth: 200,
                  }}
                >
                  <div
                    style={{
                      fontWeight: 620,
                      fontSize: 18,
                    }}
                  >
                    {l.premium ? `${moneyCents(l.premium)} / ${FREQUENCY[l.frequency]}` : "–"}
                  </div>
                  <div className="small muted">
                    {money(l.annual_premium)} per year · {PAID_VIA[l.paid_via]}
                  </div>
                  {l.paid_via === "bank" && (
                    <div
                      className="small"
                      style={{
                        marginTop: 4,
                      }}
                    >
                      {l.effective_pattern ? (
                        l.payments_12m ? (
                          <>
                            Paid {moneyCents(l.paid_12m)} over {l.payments_12m} payments (last {l.last_payment?.date})
                          </>
                        ) : (
                          <span className="muted">No payments matching “{l.effective_pattern}” found</span>
                        )
                      ) : (
                        <span className="muted">Add a keyword to match payments</span>
                      )}
                    </div>
                  )}
                  {l.next_renewal && <div className="small muted">Renews {l.next_renewal}</div>}
                  <div
                    className="row"
                    style={{
                      justifyContent: "flex-end",
                      marginTop: 8,
                    }}
                  >
                    <button className="btn small" onClick={() => a(l)}>
                      Edit
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function PolicyEditor({ p, data, onDone }) {
  var h;
  const { toast, bump, viewing } = useApp();
  const [o, u] = useState({
    insured_member_id: viewing.single?.id ?? null,
    ...p,
    coverages:
      (h = p.coverages) != null && h.length
        ? p.coverages
        : [
            {
              type: p.policy_type ?? "car",
              amount: null,
              detail: "",
            },
          ],
  });
  const l = (y) =>
    u({
      ...o,
      ...y,
    });
  const c = o.coverages ?? [];
  const d = (y, b) =>
    l({
      coverages: c.map((v, m) =>
        m === y
          ? {
              ...v,
              ...b,
            }
          : v,
      ),
    });
  async function f(y) {
    y.preventDefault();
    const b = {
      ...o,
      active: !!o.active,
      premium: o.premium === null || o.premium === undefined || o.premium === "" ? null : Number(o.premium),
      coverages: c.map((v) => ({
        ...v,
        amount: v.amount ? Number(v.amount) : null,
      })),
    };
    try {
      if (o.id) {
        await api.put(`/insurance/policies/${o.id}`, b);
      } else {
        await api.post("/insurance/policies", b);
      }
      toast("Policy saved");
      bump();
      onDone();
    } catch (v) {
      toast(v.message);
    }
  }
  return (
    <Card
      title={o.id ? `Edit ${p.name}` : "New policy"}
      style={{
        marginTop: 16,
      }}
    >
      <form
        onSubmit={f}
        className="stack"
        style={{
          gap: 12,
        }}
      >
        <div
          className="row"
          style={{
            alignItems: "flex-end",
          }}
        >
          <label className="field">
            Name
            <input
              required={true}
              value={o.name ?? ""}
              onChange={(y) =>
                l({
                  name: y.target.value,
                })
              }
              placeholder="e.g. Car – Honda Civic"
            />
          </label>
          <label className="field">
            Type
            <select
              value={o.policy_type}
              onChange={(y) =>
                l({
                  policy_type: y.target.value,
                  coverages:
                    c.length === 1 && !c[0].amount
                      ? [
                          {
                            type: y.target.value,
                            amount: null,
                            detail: "",
                          },
                        ]
                      : c,
                })
              }
            >
              {Object.entries(data.types).map(([y, b]) => (
                <option value={y} key={y}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Provider
            <input
              value={o.provider ?? ""}
              onChange={(y) =>
                l({
                  provider: y.target.value,
                })
              }
              placeholder="e.g. Intact"
            />
          </label>
          {viewing.members.length > 1 && (
            <label className="field">
              Whose policy
              <select
                value={o.insured_member_id ?? ""}
                onChange={(y) =>
                  l({
                    insured_member_id: y.target.value ? Number(y.target.value) : null,
                  })
                }
              >
                <option value="">Household / shared</option>
                {viewing.members.map((y) => (
                  <option value={y.id} key={y.id}>
                    {y.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Insured person / item
            <input
              value={o.insured ?? ""}
              onChange={(y) =>
                l({
                  insured: y.target.value,
                })
              }
              placeholder="e.g. Me, 2021 Civic"
            />
          </label>
          <label className="field">
            Reference (optional)
            <input
              value={o.reference ?? ""}
              onChange={(y) =>
                l({
                  reference: y.target.value,
                })
              }
              style={{
                width: 130,
              }}
            />
          </label>
        </div>
        <div
          className="row"
          style={{
            alignItems: "flex-end",
          }}
        >
          <label className="field">
            Premium
            <input
              type="number"
              step="0.01"
              value={o.premium ?? ""}
              onChange={(y) =>
                l({
                  premium: y.target.value,
                })
              }
              style={{
                width: 110,
              }}
            />
          </label>
          <label className="field">
            Every
            <select
              value={o.frequency}
              onChange={(y) =>
                l({
                  frequency: y.target.value,
                })
              }
            >
              {data.frequencies.map((y) => (
                <option value={y} key={y}>
                  {FREQUENCY[y]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Paid
            <select
              value={o.paid_via}
              onChange={(y) =>
                l({
                  paid_via: y.target.value,
                })
              }
            >
              {Object.entries(PAID_VIA).map(([y, b]) => (
                <option value={y} key={y}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label
            className="field"
            title="Text that appears on your bank statement for this premium. Defaults to the provider name."
          >
            Statement keyword
            <input
              value={o.match_pattern ?? ""}
              onChange={(y) =>
                l({
                  match_pattern: y.target.value,
                })
              }
              placeholder={o.provider ? o.provider.toUpperCase() : "e.g. INTACT"}
              style={{
                width: 150,
              }}
            />
          </label>
          <label className="field">
            Renewal date
            <input
              type="date"
              value={o.renewal_date ?? ""}
              onChange={(y) =>
                l({
                  renewal_date: y.target.value,
                })
              }
            />
          </label>
          <label
            className="row small"
            style={{
              gap: 4,
              paddingBottom: 6,
            }}
          >
            <input
              type="checkbox"
              checked={!!o.active}
              onChange={(y) =>
                l({
                  active: y.target.checked ? 1 : 0,
                })
              }
            />{" "}
            Active
          </label>
        </div>
        <div>
          <h3>
            Coverages{" "}
            <span
              className="muted small"
              style={{
                fontWeight: 400,
              }}
            >
              (add one line per coverage; bundles and riders can have several)
            </span>
          </h3>
          {c.map((y, b) => (
            <div className="cov-row" key={b}>
              <select
                value={y.type}
                onChange={(v) =>
                  d(b, {
                    type: v.target.value,
                  })
                }
                aria-label="Coverage type"
              >
                {Object.entries(data.types)
                  .filter(([v]) => v !== "bundle")
                  .map(([v, m]) => (
                    <option value={v} key={v}>
                      {m}
                    </option>
                  ))}
              </select>
              <input
                type="number"
                placeholder="Amount (optional)"
                value={y.amount ?? ""}
                onChange={(v) =>
                  d(b, {
                    amount: v.target.value,
                  })
                }
                aria-label="Coverage amount"
              />
              <input
                placeholder="Details, e.g. $1,000 deductible, 20-year term, 80% drugs"
                value={y.detail}
                onChange={(v) =>
                  d(b, {
                    detail: v.target.value,
                  })
                }
                aria-label="Coverage details"
              />
              <button
                type="button"
                className="btn small danger"
                onClick={() =>
                  l({
                    coverages: c.filter((v, m) => m !== b),
                  })
                }
                aria-label="Remove coverage"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn small"
            onClick={() =>
              l({
                coverages: [
                  ...c,
                  {
                    type: "life",
                    amount: null,
                    detail: "",
                  },
                ],
              })
            }
          >
            + Add coverage
          </button>
        </div>
        <label className="field">
          Notes
          <textarea
            rows={2}
            value={o.notes ?? ""}
            onChange={(y) =>
              l({
                notes: y.target.value,
              })
            }
            placeholder="Beneficiaries, agent contact, what's excluded…"
          />
        </label>
        <div className="row">
          <button className="btn primary">Save policy</button>
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
          <span className="spacer" />
          {o.id && (
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                if (confirm(`Delete ${o.name}?`)) {
                  await api.del(`/insurance/policies/${o.id}`);
                  bump();
                  onDone();
                }
              }}
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}
