import { useEffect, useRef } from "react";
import { useAuth } from "../../context/AuthContext";
import { navigateTo } from "../../lib/router";

/** Action route: revokes the session, then returns to the public landing page. */
export function LogoutPage() {
  const { logout } = useAuth();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // StrictMode double-invoke guard
    ran.current = true;
    void (async () => {
      await logout();
      navigateTo("landing");
    })();
  }, [logout]);

  return (
    <div className="auth-splash" role="status" aria-live="polite">
      <span className="auth-spinner lg" aria-hidden="true" />
      <p>Signing you out…</p>
    </div>
  );
}
