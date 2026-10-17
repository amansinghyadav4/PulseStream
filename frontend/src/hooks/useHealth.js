import { useEffect, useState } from "react";

const INITIAL = { apiReachable: null, readyHttpOk: false, ready: null };
const POLL_MS = 5000;

/* Shared polling store so Overview pipeline + Health page read one source */
let snapshot = INITIAL;
const listeners = new Set();
let ticker = null;
let users = 0;

async function pollOnce() {
  const next = { ...INITIAL };
  try {
    const h = await fetch("/api/v1/health");
    const hj = await h.json();
    next.apiReachable = h.ok && hj?.status === "ok";
  } catch {
    next.apiReachable = false;
  }
  try {
    // /ready returns 503 when not_ready — body still carries dependency truth
    const r = await fetch("/api/v1/ready");
    next.ready = await r.json();
    next.readyHttpOk = r.ok;
  } catch {
    next.ready = null;
  }
  snapshot = next;
  listeners.forEach((fn) => fn(snapshot));
}

function acquire() {
  users += 1;
  if (ticker === null) {
    void pollOnce();
    ticker = setInterval(() => void pollOnce(), POLL_MS);
  }
  window.addEventListener("ps:refresh", pollOnce);
}

function release() {
  users -= 1;
  if (users <= 0) {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
    window.removeEventListener("ps:refresh", pollOnce);
  }
}

/** Shared /health + /ready polling (5s) with reference-counted interval. */
export function useHealth() {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    acquire();
    setState(snapshot);
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
      release();
    };
  }, []);
  return state;
}
