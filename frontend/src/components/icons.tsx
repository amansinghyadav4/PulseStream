/** Minimal inline SVG icon set (stroke-based, 20px grid). No icon dependency. */
import type { JSX } from "react";

type IconProps = { size?: number; className?: string };

function base(size: number | undefined, className: string | undefined): JSX.IntrinsicElements["svg"] {
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

export function IconPulse({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 12h4l2.5-7 4 14L16 12h5" />
    </svg>
  );
}

export function IconGauge({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 13l4-4" />
      <path d="M20.5 15.5a9 9 0 1 0-17 0" />
      <circle cx="12" cy="14" r="1.4" />
    </svg>
  );
}

export function IconLayers({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

export function IconActivity({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M22 12h-4l-3 8-6-16-3 8H2" />
    </svg>
  );
}

export function IconClock({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

export function IconCheckCircle({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  );
}

export function IconAlertTriangle({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M10.3 4.1 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function IconTimer({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M10 2h4" />
      <path d="M12 14v-4" />
      <circle cx="12" cy="14" r="8" />
    </svg>
  );
}

export function IconRadio({ size, className }: IconProps) {
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

export function IconCommit({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v5.8M12 15.2V21" />
      <path d="M3 12h5.8M15.2 12H21" />
    </svg>
  );
}

export function IconDatabase({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5V18c0 1.66 3.58 3 8 3s8-1.34 8-3V5.5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

export function IconStream({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 6h16M4 12h10M4 18h7" />
      <circle cx="19" cy="12" r="1.6" />
      <circle cx="16" cy="18" r="1.6" />
    </svg>
  );
}

export function IconBolt({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </svg>
  );
}

export function IconServer({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

export function IconInbox({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7Z" />
    </svg>
  );
}

export function IconList({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
}

export function IconHeartbeat({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </svg>
  );
}

export function IconStore({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 7 5.5 3h13L20 7" />
      <path d="M4 7h16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
      <path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" />
      <path d="M9.5 21v-5h5v5" />
    </svg>
  );
}

export function IconKey({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2m-4 0 3 3m-6 3 3 3" />
    </svg>
  );
}

export function IconTerminal({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

export function IconCopy({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

export function IconCheck({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="m5 12 4.5 4.5L19 7" />
    </svg>
  );
}

export function IconTrash({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function IconShield({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3 5 6v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function IconCode({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />
    </svg>
  );
}

export function IconArrowRight({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconArrowLeft({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M20 12H5M11 6l-6 6 6 6" />
    </svg>
  );
}
