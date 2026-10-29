import { usePhone } from "../context";

export function PhoneStatus() {
  const e = usePhone();
  if (!e) {
    return null;
  }
  const t = new Date(e.meta.created);
  const n = Math.floor((Date.now() - t.getTime()) / 86400000);
  return (
    <>
      <div className={n >= 7 ? "phone-stale" : undefined}>
        Data from{" "}
        {t.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}{" "}
        {t.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        })}
        {n >= 1 && ` (${n} day${n === 1 ? "" : "s"} ago)`}
      </div>
      View-only copy · changes are made on your PC.
      <div className="phone-actions">
        <button className="btn small" onClick={e.pickNewer}>
          Get newer data
        </button>
        <button className="btn small" onClick={e.lock}>
          Lock
        </button>
      </div>
    </>
  );
}
