import type { JSX } from "react";
import { clsx } from "clsx";

type Variant = "green" | "red" | "yellow" | "blue" | "gray" | "orange" | "purple";

const VARIANTS: Record<Variant, string> = {
  green:  "bg-emerald-900/60 text-emerald-300 ring-emerald-700/50",
  red:    "bg-red-900/60 text-red-300 ring-red-700/50",
  yellow: "bg-yellow-900/60 text-yellow-300 ring-yellow-700/50",
  blue:   "bg-blue-900/60 text-blue-300 ring-blue-700/50",
  gray:   "bg-gray-800/60 text-gray-400 ring-gray-700/50",
  orange: "bg-orange-900/60 text-orange-300 ring-orange-700/50",
  purple: "bg-purple-900/60 text-purple-300 ring-purple-700/50",
};

interface Props { label: string; variant?: Variant; className?: string }

export function Badge({ label, variant = "gray", className }: Props) {
  return (
    <span className={clsx("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset", VARIANTS[variant], className)}>
      {label}
    </span>
  );
}

export function stateBadge(state: string | null): JSX.Element {
  const map: Record<string, Variant> = {
    production: "green", staging: "blue", loaner: "purple",
    defective: "red", spare: "yellow",
  };
  return <Badge label={state || "unknown"} variant={map[state || ""] || "gray"} />;
}

export function tcStatusBadge(worker: { tc: { last_active: string | null; quarantined: boolean | null; state: string | null } }): JSX.Element {
  const { last_active, quarantined, state } = worker.tc;
  if (quarantined) return <Badge label="quarantined" variant="red" />;
  if (!last_active) return <Badge label="never seen" variant="gray" />;
  const hoursAgo = (Date.now() - new Date(last_active).getTime()) / 36e5;
  if (hoursAgo > 24) return <Badge label={`inactive ${Math.round(hoursAgo)}h`} variant="orange" />;
  return <Badge label={state || "active"} variant="green" />;
}

export function enrollmentBadge(status: string | null): JSX.Element {
  return <Badge label={status || "?"} variant={status === "enrolled" ? "green" : status === "unenrolled" ? "red" : "gray"} />;
}
