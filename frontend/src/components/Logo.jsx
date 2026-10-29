export function Logo() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{
        flex: "none",
      }}
    >
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path
        d="M8 22l5-6 4 3 7-9"
        stroke="white"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
