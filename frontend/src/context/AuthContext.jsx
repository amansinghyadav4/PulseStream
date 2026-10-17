import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, AUTH_EXPIRED_EVENT } from "../lib/apiClient";

const AuthContext = createContext(null);

/**
 * Owns authentication state for the whole app. Source of truth is the
 * server-side session cookie — never localStorage — so state is derived from
 * `/auth/me` on mount and after every mutation. A global `ps:auth-expired`
 * event (dispatched by the API client on a 401) drops us to unauthenticated.
 */
export function AuthProvider({ children }) {
  const [status, setStatus] = useState("loading");
  const [user, setUser] = useState(null);
  // Guards against a late in-flight /me resolving after an explicit logout.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const me = await api.get("/api/v1/auth/me", { silent401: true });
      if (gen !== generation.current) return user;
      setUser(me);
      setStatus("authenticated");
      return me;
    } catch (err) {
      if (gen !== generation.current) return null;
      // 401 (no/expired session) is the normal unauthenticated case, not an error.
      setUser(null);
      setStatus("unauthenticated");
      return null;
    }
  }, [user]);

  const login = useCallback(async (email, password) => {
    await api.post("/api/v1/auth/login", { email, password }, { silent401: true });
    const me = await refresh();
    if (!me) throw new ApiError(500, { code: "session_error", message: "signed in but session could not be established" });
    return me;
  }, [refresh]);

  const signup = useCallback(async (email, password, fullName) => {
    const body = { email, password };
    if (fullName && fullName.trim()) body.full_name = fullName.trim();
    await api.post("/api/v1/auth/signup", body, { silent401: true });
    const me = await refresh();
    if (!me) throw new ApiError(500, { code: "session_error", message: "account created but session could not be established" });
    return me;
  }, [refresh]);

  const logout = useCallback(async () => {
    generation.current++; // invalidate any in-flight refresh
    try {
      await api.post("/api/v1/auth/logout", undefined, { silent401: true });
    } catch {
      // Even if the server call fails, drop local auth state — the user asked to leave.
    }
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  // Initial session probe.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global 401 handler: any protected call that 401s resets us to unauthenticated.
  useEffect(() => {
    const onExpired = () => {
      generation.current++;
      setUser(null);
      setStatus("unauthenticated");
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const value = useMemo(
    () => ({ status, user, refresh, login, signup, logout }),
    [status, user, refresh, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
