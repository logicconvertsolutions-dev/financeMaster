const KIND_GROUPS = [
  ["essential", "Essentials"],
  ["discretionary", "Discretionary"],
  ["income", "Income"],
  ["transfer", "Transfers (not spending)"],
  ["ignore", "Ignored"],
];

export function CategoryOptions({ cats }) {
  return (
    <>
      {KIND_GROUPS.map(([t, n]) => {
        const r = cats.filter((a) => a.kind === t).sort((a, i) => a.name.localeCompare(i.name));
        if (r.length) {
          return (
            <optgroup label={n} key={t}>
              {r.map((a) => (
                <option value={a.name} key={a.name}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          );
        } else {
          return null;
        }
      })}
    </>
  );
}
