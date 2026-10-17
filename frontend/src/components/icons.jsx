/** Minimal inline svg icon set (stroke-based, 20px grid). No icon dependency. */

function base(size, className) {
  return {
    width: size ?? 16,
    height: size ?? 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    className,
  };
}

export function IconPulse({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 12h4l2.5-7 4 14L16 12h5" />
    </svg>
  );
}

export function IconGauge({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 13l4-4" />
      <path d="M20.5 15.5a9 9 0 1 0-17 0" />
      <circle cx="12" cy="14" r="1.4" />
    </svg>
  );
}

export function IconLayers({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

export function IconActivity({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M22 12h-4l-3 8-6-16-3 8H2" />
    </svg>
  );
}

export function IconClock({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

export function IconCheckCircle({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  );
}

export function IconAlertTriangle({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M10.3 4.1 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function IconTimer({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M10 2h4" />
      <path d="M12 14v-4" />
      <circle cx="12" cy="14" r="8" />
    </svg>
  );
}

export function IconRadio({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
      <path d="M19 5a10 10 0 0 1 0 14" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4" />
      <path d="M5 5a10 10 0 0 0 0 14" />
    </svg>
  );
}

export function IconCommit({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v5.8M12 15.2V21" />
      <path d="M3 12h5.8M15.2 12H21" />
    </svg>
  );
}

export function IconDatabase({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5V18c0 1.66 3.58 3 8 3s8-1.34 8-3V5.5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

export function IconStream({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 6h16M4 12h10M4 18h7" />
      <circle cx="19" cy="12" r="1.6" />
      <circle cx="16" cy="18" r="1.6" />
    </svg>
  );
}

export function IconBolt({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </svg>
  );
}

export function IconServer({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

export function IconInbox({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7Z" />
    </svg>
  );
}

export function IconList({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
}

export function IconHeartbeat({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </svg>
  );
}

export function IconStore({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 7 5.5 3h13L20 7" />
      <path d="M4 7h16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
      <path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" />
      <path d="M9.5 21v-5h5v5" />
    </svg>
  );
}

export function IconKey({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2m-4 0 3 3m-6 3 3 3" />
    </svg>
  );
}

export function IconTerminal({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

export function IconCopy({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

export function IconCheck({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="m5 12 4.5 4.5L19 7" />
    </svg>
  );
}

export function IconShield({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3 5 6v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function IconCode({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />
    </svg>
  );
}

export function IconArrowRight({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconArrowLeft({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M20 12H5M11 6l-6 6 6 6" />
    </svg>
  );
}

export function IconSun({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

export function IconMoon({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

export function IconX({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function IconMenu({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function IconSearch({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function IconChevronLeft({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="m14.5 5-7 7 7 7" />
    </svg>
  );
}

export function IconChevronRight({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="m9.5 5 7 7-7 7" />
    </svg>
  );
}

export function IconRefresh({ size, className }) {
  return (
    <svg {...base(size, className)}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

/** Google's four-colour "G" — brand mark for the OAuth button. Drawn as filled
 *  paths (no external asset), and only ever rendered when the backend reports
 *  that Google sign-in is actually configured. */
export function IconGoogle({ size = 16, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.28a12 12 0 0 0 0 10.77l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.62l4.01 3.1C6.23 6.88 8.88 4.77 12 4.77Z"
      />
    </svg>
  );
}

