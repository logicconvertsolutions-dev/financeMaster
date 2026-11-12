const PATHS = {
  overview: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
  family: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 5.2a3 3 0 0 1 0 5.6M17.5 14.3A6 6 0 0 1 21 20",
  review: "M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4",
  spending: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h4",
  networth: "M4 18l5-6 4 3 7-9M15 6h5v5",
  investments: "M5 20v-9M12 20V4M19 20v-6",
  debts:
    "M12 3v18M16.5 7.5c-.8-1.2-2.4-2-4.5-2-2.5 0-4 1.2-4 3s1.5 2.6 4 3 4.5 1.2 4.5 3.2-1.8 3.3-4.5 3.3c-2.3 0-4-.9-4.8-2.3",
  insurance: "M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6z",
  people: "M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20a7 7 0 0 1 14 0",
  inbox: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6",
  accounts: "M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  settings: "M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5",
  more: "M4 7h16M4 12h16M4 17h16",
};

export function NavIcon({ id, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={PATHS[id]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
