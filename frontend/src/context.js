import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";

export const AppContext = createContext({
  version: 0,
  bump: () => {},
  toast: () => {},
  viewing: {
    label: "Everyone",
    ids: null,
    single: null,
    members: [],
  },
});

export const useApp = () => useContext(AppContext);

export function useApi(e) {
  const { version } = useApp();
  const [n, r] = useState(null);
  const [a, i] = useState(null);
  const [o, u] = useState(true);
  const [l, c] = useState(0);
  useEffect(() => {
    if (!e) {
      return;
    }
    let f = true;
    u(true);
    api
      .get(e)
      .then((p) => f && (r(p), i(null)))
      .catch((p) => f && i(String(p.message ?? p)))
      .finally(() => f && u(false));
    return () => {
      f = false;
    };
  }, [e, version, l]);
  const d = useCallback(() => c((f) => f + 1), []);
  return {
    data: n,
    error: a,
    loading: o,
    reload: d,
  };
}

export const WebContext = createContext(null);

export const useWeb = () => useContext(WebContext);
