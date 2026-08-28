import { useState } from "react";

/** Copy-to-clipboard with transient "copied" feedback. Never throws. */
export function CopyButton({ value, label = "copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable (permissions/insecure context) — stay silent */
        }
      }}
    >
      {copied ? "copied" : "⧉"}
    </button>
  );
}
