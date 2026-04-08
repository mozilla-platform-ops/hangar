import type { JSX } from "react";
import { clsx } from "clsx";

type Variant = "green" | "red" | "yellow" | "blue" | "gray" | "orange" | "purple";

const VARIANTS: Record<Variant, string> = {
  green:  "bg-emerald-950/80 text-emerald-300 ring-emerald-500/25",
  red:    "bg-red-950/80 text-red-300 ring-red-500/25",
  yellow: "bg-yellow-950/80 text-yellow-300 ring-yellow-500/25",
  blue:   "bg-blue-950/80 text-blue-300 ring-blue-500/25",
  gray:   "bg-gray-800/60 text-gray-400 ring-gray-600/25",
  orange: "bg-orange-950/80 text-orange-300 ring-orange-500/25",
  purple: "bg-purple-950/80 text-purple-300 ring-purple-500/25",
};

const DOT_COLORS: Record<Variant, string> = {
  green:  "bg-emerald-400",
  red:    "bg-red-400",
  yellow: "bg-yellow-400",
  blue:   "bg-blue-400",
  gray:   "bg-gray-500",
  orange: "bg-orange-400",
  purple: "bg-purple-400",
};

interface Props { label: string; variant?: Variant; dot?: boolean; pulse?: boolean; className?: string }

export function Badge({ label, variant = "gray", dot = false, pulse = false, className }: Props) {
  return (
    <span className={clsx(
      "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset",
      VARIANTS[variant], className
    )}>
      {dot && (
        <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", DOT_COLORS[variant], pulse && "animate-pulse")} />
      )}
      {label}
    </span>
  );
}

export function stateBadge(state: string | null): JSX.Element {
  const map: Record<string, Variant> = {
    production: "green", staging: "blue", loaner: "purple",
    defective: "red", spare: "yellow",
  };
  const variant = map[state || ""] || "gray";
  return <Badge label={state || "unknown"} variant={variant} dot />;
}

export function tcStatusBadge(worker: { tc: { last_active: string | null; quarantined: boolean | null; state: string | null } }): JSX.Element {
  const { last_active, quarantined, state } = worker.tc;
  if (quarantined) return <Badge label="quarantined" variant="red" dot />;
  if (!last_active) return <Badge label="never seen" variant="gray" dot />;
  const hoursAgo = (Date.now() - new Date(last_active).getTime()) / 36e5;
  if (hoursAgo > 24) return <Badge label={`inactive ${Math.round(hoursAgo)}h`} variant="orange" dot />;
  return <Badge label={state || "active"} variant="green" dot pulse />;
}

export function enrollmentBadge(status: string | null): JSX.Element {
  const variant = status === "enrolled" ? "green" : status === "unenrolled" ? "red" : "gray";
  return <Badge label={status || "?"} variant={variant} dot />;
}
