import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Zap } from "lucide-react";
import { api, type ReprovisionJob } from "../api";
import { usePoll } from "../lib/useLive";
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
 * Fleet-wide reprovision monitor. Polls the (allowlist-gated) jobs endpoint and, when there's
 * activity, doubles as a live pool-wipe dashboard: a batch summary (done/total + a segmented
 * progress bar) plus each host's state AND its current step (the runner's latest streamed line),
 * so an operator can watch a whole pool reprovision at a glance — no SSH, no clicking into each
 * worker. Renders nothing for non-authorized users (endpoint 403s → empty) or when idle.
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

  // Poll fast while something's running, slow otherwise. usePoll (not a raw setInterval)
  // so a backgrounded tab stops hitting the endpoint and resumes instantly on return:
  // this is an at-a-glance panel, worthless while nobody's looking, and the shared
  // reprovision endpoint is the single biggest source of request volume.
  usePoll(load, anyActive ? 3_000 : 15_000);

  if (relevant.length === 0) return null;

  // Batch summary — the currently-visible set is effectively one "wave" (a pool wipe enqueues
  // its hosts together, so they share the afterglow window).
  const total = relevant.length;
  const running = relevant.filter((j) => ACTIVE.has(j.state)).length;
  const succeeded = relevant.filter((j) => j.state === "succeeded").length;
  const failed = relevant.filter((j) => j.state === "failed").length;
  const done = succeeded + failed;
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : "0%");

  return (
    <div className={`card p-5 ${anyActive ? "card-glow-yellow" : ""}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-[0.1em] flex items-center gap-2">
          <RefreshCw size={12} className={`text-brand-400 ${anyActive ? "animate-spin" : ""}`} /> Reprovisions
        </h3>
        {anyActive ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
            <Zap size={10} /> {done}/{total} complete
          </span>
        ) : (
          <span className="text-[10px] text-gray-500">{done}/{total} complete</span>
        )}
      </div>

      {/* Batch progress bar — only meaningful for a multi-host wave (a pool wipe). */}
      {total > 1 && (
        <div className="mb-3">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
            <div className="bg-emerald-500" style={{ width: pct(succeeded) }} />
            <div className="bg-red-500" style={{ width: pct(failed) }} />
            <div className={`bg-amber-500 ${anyActive ? "animate-pulse" : ""}`} style={{ width: pct(running) }} />
          </div>
          <div className="mt-1 flex gap-3 text-[10px] text-gray-500">
            {succeeded > 0 && <span className="text-emerald-400">✓ {succeeded} succeeded</span>}
            {running > 0 && <span className="text-amber-400">◌ {running} running</span>}
            {failed > 0 && <span className="text-red-400">✗ {failed} failed</span>}
          </div>
        </div>
      )}

      <ul className="divide-y divide-gray-800/50">
        {relevant.map((j) => {
          const isActive = ACTIVE.has(j.state);
          return (
            <li key={j.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <Link
                  to={`/workers/${j.short}`}
                  className="font-mono text-sm text-gray-200 hover:text-white transition-colors"
                >
                  {j.short}
                </Link>
                {/* Live current step — the runner's latest streamed line — so the whole pool's
                    progress is visible here without opening each worker. */}
                {isActive && j.detail && (
                  <div className="text-[11px] text-gray-400 font-mono truncate max-w-[22rem]" title={j.detail}>
                    {j.detail}
                  </div>
                )}
                <div className="text-[11px] text-gray-600 truncate">
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
