import { Alert, Card } from "./ui";
import { useApi } from "../context";

export function ConsistencyCheck() {
  const { data, loading, reload } = useApi("/checks");
  return (
    <Card
      title="Consistency check"
      extra={
        <button className="btn small" onClick={reload} disabled={loading}>
          {loading ? "Checking…" : "Run again"}
        </button>
      }
    >
      <p
        className="small muted"
        style={{
          marginTop: 0,
        }}
      >
        Recomputes the same figures the way each page does and compares them: net worth, investments, debts, monthly
        income and spending, categories, people & loans, contribution room, family totals. Runs for whoever you're
        viewing.
      </p>
      {data ? (
        <>
          <p
            style={{
              fontWeight: 600,
            }}
          >
            {data.errors ? `⛔ ${data.errors} mismatch${data.errors > 1 ? "es" : ""}` : "✅ All pages agree"}
            {data.warnings ? ` · ⚠️ ${data.warnings} to tidy up` : ""}
          </p>
          <div
            className="stack"
            style={{
              gap: 6,
            }}
          >
            {data.results
              .filter((r) => !r.ok)
              .map((r) => (
                <Alert
                  severity={r.severity === "error" ? "bad" : "warn"}
                  title={r.title}
                  detail={r.detail}
                  key={r.id}
                />
              ))}
          </div>
          <details
            style={{
              marginTop: 10,
            }}
          >
            <summary
              className="small muted"
              style={{
                cursor: "pointer",
              }}
            >
              All {data.results.length} checks
            </summary>
            <ul
              className="small"
              style={{
                margin: "8px 0 0",
                paddingLeft: 18,
              }}
            >
              {data.results.map((r) => (
                <li key={r.id}>
                  {r.ok ? "✓" : r.severity === "error" ? "✗" : "!"} {r.title}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="muted">Checking…</p>
      )}
    </Card>
  );
}

export function CheckBanner({ go }) {
  const { data } = useApi("/checks");
  if (!data || (!data.errors && !data.warnings)) {
    return null;
  }
  const n = data.results.find((r) => r.severity === "error") ?? data.results.find((r) => r.severity === "warn");
  return (
    <div
      style={{
        marginBottom: 16,
      }}
    >
      <Alert
        severity={data.errors ? "bad" : "warn"}
        title={
          data.errors
            ? `${data.errors} figure${data.errors > 1 ? "s don't" : " doesn't"} match between pages`
            : `${data.warnings} thing${data.warnings > 1 ? "s" : ""} to tidy up`
        }
        detail={`${n.title}${n.detail ? `: ${n.detail}` : ""}`}
      />
      <button
        className="btn small"
        style={{
          marginTop: 6,
        }}
        onClick={() => go("settings?tab=data")}
      >
        See all checks
      </button>
    </div>
  );
}
