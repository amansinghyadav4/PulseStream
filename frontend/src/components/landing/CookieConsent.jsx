import { useEffect, useRef, useState } from "react";

/**
 * Cookie / local-storage consent banner.
 *
 * Honesty rules this component follows:
 *  - Only categories that EXIST are listed. PulseStream sets no analytics,
 *    advertising or third-party tracking cookies, so none are offered and none
 *    are described as if they were implemented.
 *  - "Strictly necessary" is the two cookies the session depends on
 *    (`ps_session`, httpOnly, and `ps_csrf`, the double-submit CSRF token).
 *    They cannot be switched off — without them sign-in does not work.
 *  - "Preferences" is the visitor's own UI choice (theme). If declined, the
 *    choice is kept for the current visit only (sessionStorage) instead of being
 *    remembered — a real, honest degradation rather than a fake toggle.
 *  - Accept and decline have identical prominence; declining is one click.
 */

export const CONSENT_KEY = "ps_cookie_consent";
export const CONSENT_VERSION = 1;

/** The stored decision, or null when nothing has been decided (or the record is
 *  from an older schema and must be asked again). */
export function readConsent() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CONSENT_VERSION) return null;
    return { preferences: parsed.preferences === true, decidedAt: parsed.decidedAt ?? null };
  } catch {
    return null;
  }
}

export function writeConsent({ preferences }) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CONSENT_KEY,
      JSON.stringify({ version: CONSENT_VERSION, preferences: preferences === true, decidedAt: new Date().toISOString() }),
    );
    // Granting preference storage promotes any choice made during this visit
    // (held in sessionStorage) into remembered storage. Key shared with
    // ThemeToggle.jsx — kept literal here to avoid a circular import.
    if (preferences === true) {
      const themed = window.sessionStorage.getItem("ps_theme");
      if (themed === "light" || themed === "dark") {
        window.localStorage.setItem("ps_theme", themed);
        window.sessionStorage.removeItem("ps_theme");
      }
    }
  } catch {
    /* storage full/blocked — the banner simply reappears next visit */
  }
}

/** True when the visitor has allowed optional preference storage. */
export function prefsAllowed() {
  return readConsent()?.preferences === true;
}

export function CookieConsent() {
  const [decision, setDecision] = useState(() => readConsent());
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState(() => readConsent()?.preferences ?? true);
  const prefsRef = useRef(null);

  // Move focus into the preferences panel when it opens (keyboard users land
  // somewhere useful instead of at the top of the document).
  useEffect(() => {
    if (showPrefs) prefsRef.current?.focus?.();
  }, [showPrefs]);

  useEffect(() => {
    if (!showPrefs) return;
    const onKey = (e) => {
      if (e.key === "Escape") setShowPrefs(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showPrefs]);

  if (decision) return null;

  const decide = (preferences) => {
    writeConsent({ preferences });
    setDecision({ preferences, decidedAt: new Date().toISOString() });
    setShowPrefs(false);
  };

  return (
    <div className="ls-cookie" role="region" aria-label="Cookie and storage preferences">
      {showPrefs ? (
        <div
          className="ls-cookie-prefs"
          ref={prefsRef}
          tabIndex={-1}
          role="group"
          aria-label="Manage cookie preferences"
        >
          <h3>Cookie preferences</h3>
          <p>
            PulseStream uses no analytics, advertising or third-party tracking cookies.
            You are choosing what this site may store on your device.
          </p>

          <div className="ls-cookie-cat">
            <div>
              <div className="ls-cookie-cat-name">
                Strictly necessary <span>Always on</span>
              </div>
              <p>
                The session cookie that keeps you signed in (<code>ps_session</code>, httpOnly)
                and the CSRF token that protects form submissions (<code>ps_csrf</code>). The
                product cannot work without them.
              </p>
            </div>
            <button type="button" className="ls-cookie-switch" aria-pressed="true" disabled aria-label="Strictly necessary cookies, always on" />
          </div>

          <div className="ls-cookie-cat">
            <div>
              <div className="ls-cookie-cat-name">Preferences</div>
              <p>
                Remembers interface choices you make, such as the landing page theme, so they
                are not reset on your next visit. Nothing here is shared or used for tracking.
              </p>
            </div>
            <button
              type="button"
              className="ls-cookie-switch"
              aria-pressed={prefs}
              aria-label="Preference storage"
              onClick={() => setPrefs((p) => !p)}
            />
          </div>

          <div className="ls-cookie-foot">
            <button type="button" className="ls-btn ls-btn-outline" onClick={() => setShowPrefs(false)}>
              Back
            </button>
            <button type="button" className="ls-btn ls-btn-primary" onClick={() => decide(prefs)}>
              Save preferences
            </button>
          </div>
        </div>
      ) : (
        <div className="ls-cookie-panel">
          <div className="ls-cookie-copy">
            <strong>Cookies on PulseStream</strong>
            We use a session cookie to keep you signed in, and — with your permission —
            local storage to remember your theme. No analytics or advertising tracking.{" "}
            <button type="button" className="link" onClick={() => setShowPrefs(true)}>
              Manage preferences
            </button>
          </div>
          <div className="ls-cookie-actions">
            <button type="button" className="ls-btn ls-btn-outline" onClick={() => decide(false)}>
              Necessary only
            </button>
            <button type="button" className="ls-btn ls-btn-primary" onClick={() => decide(true)}>
              Accept all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
