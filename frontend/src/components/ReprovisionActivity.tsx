import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Zap } from "lucide-react";
import { api, type ReprovisionJob } from "../api";
import { Badge } from "./Badge";

const ACTIVE = new Set(["queued", "claimed", "running"]);
const AFTERGLOW_MS = 30 * 60 * 1000; // keep a finished run visible for 30 min

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Fleet-wide reprovision indicator. Polls the (allowlist-gated) jobs endpoint and shows a card
 * only when there's activity — an operator sees when *anyone* kicks off a reprovision and can
 * jump straight to that worker to watch the live timeline. Renders nothing for non-authorized
 * users (the endpoint 403s → empty) or when nothing's happening.
 */
export function ReprovisionActivity() {
  const [jobs, setJobs] = useState<ReprovisionJob[] | null>(null);

  const load = () => api.reprovision.jobs().then((d) => setJobs(d.jobs)).catch(() => setJobs([]));
  useEffect(() => {
    load();
  }, []);

  const relevant = (jobs ?? []).filter(
    (j) => ACTIVE.has(j.state) || (j.finished_at && Date.now() - new Date(j.finished_at).getTime() < AFTERGLOW_MS),
  );
  const anyActive = relevant.some((j) => ACTIVE.has(j.state));

  // Poll fast while something's running, slow otherwise.
  useEffect(() => {
    const id = setInterval(load, anyActive ? 3_000 : 15_000);
    return () => clearInterval(id);
  }, [anyActive]);

  if (relevant.length === 0) return null;

  return (
    <div className={`card p-5 ${anyActive ? "card-glow-yellow" : ""}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-[0.1em] flex items-center gap-2">
          <RefreshCw size={12} className={`text-brand-400 ${anyActive ? "animate-spin" : ""}`} /> Reprovisions
        </h3>
        {anyActive && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
            <Zap size={10} /> in progress
          </span>
        )}
      </div>
      <ul className="divide-y divide-gray-800/50">
        {relevant.map((j) => {
          const isActive = ACTIVE.has(j.state);
          return (
            <li key={j.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <Link
                  to={`/workers/${j.short}`}
                  className="font-mono text-sm text-gray-200 hover:text-white transition-colors"
                >
                  {j.short}
                </Link>
                <div className="text-[11px] text-gray-500 truncate">
                  by {j.requested_by.split("@")[0]} · {timeAgo(isActive ? j.claimed_at ?? j.created_at : j.finished_at)}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge
                  label={j.state}
                  variant={j.state === "succeeded" ? "green" : j.state === "failed" ? "red" : isActive ? "yellow" : "gray"}
                  dot
                  pulse={isActive}
                />
                {isActive && (
                  <Link
                    to={`/workers/${j.short}`}
                    className="text-[11px] text-brand-400 hover:text-brand-300 transition-colors"
                  >
                    watch →
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
