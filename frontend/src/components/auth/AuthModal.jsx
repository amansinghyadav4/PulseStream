import { useCallback, useEffect, useRef, useState } from "react";
import { LoginForm, SignupForm } from "./forms";
import { IconPulse, IconX } from "../icons";

/** Anything that can receive focus — used for the initial focus and the Tab trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Centered authentication dialog used on the landing page so a visitor can sign
 * in or create an account WITHOUT leaving the marketing page. The forms are the
 * same components the `#/login` and `#/signup` routes render (see forms.jsx), so
 * validation, error mapping and the AuthContext calls are not duplicated.
 *
 * Accessibility contract: role="dialog" + aria-modal, labelled by its heading,
 * initial focus moved into the panel, Tab trapped inside it, Escape and backdrop
 * close it, focus restored to whatever opened it, body scroll locked (with
 * scrollbar-width compensation) and released on unmount. The close animation is
 * skipped entirely under prefers-reduced-motion.
 */
export function AuthModal({ mode, onClose, onSwitch }) {
  const panelRef = useRef(null);
  const closingRef = useRef(false);
  const restoreRef = useRef(null);
  const timerRef = useRef(0);
  const [closing, setClosing] = useState(false);

  // Capture whatever had focus BEFORE the dialog rendered (React's autoFocus
  // runs during the commit, so a passive effect would capture the dialog's own
  // input instead of the control that opened it).
  if (restoreRef.current === null) restoreRef.current = document.activeElement;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setClosing(true);
    timerRef.current = window.setTimeout(onClose, 160);
  }, [onClose]);

  // Initial focus + body scroll lock + focus restoration.
  useEffect(() => {
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    // Compensate for the removed scrollbar so the page behind does not jump.
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;

    // The form auto-focuses its first field; only take focus ourselves if
    // nothing inside the dialog has claimed it.
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const first = panel.querySelector(FOCUSABLE);
      (first ?? panel)?.focus?.();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      window.clearTimeout(timerRef.current);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
      const prev = restoreRef.current;
      if (prev && typeof prev.focus === "function" && document.contains(prev)) prev.focus();
    };
  }, []);

  // Escape to close, Tab trapped within the panel.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  const isSignup = mode === "signup";
  const title = isSignup ? "Create your account" : "Sign in";

  return (
    <div
      className={`ls-modal-backdrop${closing ? " is-closing" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className="ls-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ls-modal-title"
        ref={panelRef}
        tabIndex={-1}
      >
        <button type="button" className="ls-modal-close" onClick={requestClose} aria-label="Close dialog">
          <IconX size={15} />
        </button>

        <header className="ls-modal-head">
          <span className="ls-modal-brand">
            <IconPulse size={15} />
            PulseStream
          </span>
          <h2 id="ls-modal-title">{title}</h2>
          <p>
            {isSignup
              ? "Start monitoring your event pipeline in minutes."
              : "Welcome back. Enter your credentials to access your workspace."}
          </p>
        </header>

        {isSignup ? <SignupForm key="signup" onSuccess={onClose} /> : <LoginForm key="signin" onSuccess={onClose} />}

        <p className="ls-modal-switch">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <button type="button" onClick={() => onSwitch("signin")}>
                Sign in
              </button>
            </>
          ) : (
            <>
              New to PulseStream?{" "}
              <button type="button" onClick={() => onSwitch("signup")}>
                Create an account
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
