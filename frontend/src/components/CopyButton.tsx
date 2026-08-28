import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "./icons";

/**
 * Copy-to-clipboard button with an accessible, self-resetting "Copied" state.
 * Uses the async Clipboard API when available and falls back to a hidden
 * textarea + execCommand for non-secure/older contexts. The label is
 * announced via aria-live so keyboard/screen-reader users get confirmation.
 */
export function CopyButton({
  value,
  className = "btn",
  label = "Copy",
  copiedLabel = "Copied",
  title,
  compact = false,
}: {
  value: string;
  className?: string;
  label?: string;
  copiedLabel?: string;
  title?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Silent: clipboard may be blocked. The raw value is still visible on screen.
    }
  };

  const size = compact ? 12 : 13;
  return (
    <button
      type="button"
      className={`${className} copy-action ${copied ? "is-copied" : ""}`}
      onClick={copy}
      title={title ?? label}
      aria-label={copied ? copiedLabel : title ?? label}
    >
      {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
      {compact ? null : <span aria-live="polite">{copied ? copiedLabel : label}</span>}
    </button>
  );
}
