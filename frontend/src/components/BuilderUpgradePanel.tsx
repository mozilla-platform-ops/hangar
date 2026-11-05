import { useEffect, useState } from "react";
import { ArrowUpCircle, Lock, SearchCheck } from "lucide-react";
import { api } from "../api";
import type { BuilderUpgradeHost, ReprovisionJob } from "../api";
import { Badge } from "./Badge";
import { usePoll } from "../lib/useLive";

/**
 * Intel r8 builder 10.15 -> macOS 15, in place, from the builder's own page: the on-network
 * runner drains the worker, runs startosinstall, installs Xcode 16.4, switches to the 1500 role,
 * converges puppet, restores autologin and reboots (relops-bootstrap `reprovision builder-upgrade`).
 * One upgrade per pool at a time, and never a pool's last in-service worker; the backend enforces
 * both. Hosts with a T2 below 20P are refused by the runner's preflight (they need a DFU revive
 * first) -- "Check" runs just that preflight.
 *
 * Renders only for the reprovision allowlist, only when a runner is wired up, and only on a 1015
 * builder that still needs it (or has an upgrade open). The job's live trail streams in the
 * Reprovision panel below, which follows any open job on the host.
 */

const STATE_VARIANT: Record<ReprovisionJob["state"], "green" | "red" | "yellow" | "blue" | "gray"> = {
  queued: "gray", claimed: "blue", running: "blue", succeeded: "green", failed: "red", canceled: "gray",
};

const shortHost = (h: string) => h.replace(/\.test\.releng\..*$/, "");
const poolName = (pool: string) => pool.split("/")[1] ?? pool;

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

export function BuilderUpgradePanel({ hostname }: { hostname: string }) {
  const [authorized, setAuthorized] = useState(false);
  const [data, setData] = useState<{ hosts: BuilderUpgradeHost[]; runner_enabled: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [unquarantine, setUnquarantine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.reprovision.access().then(a => setAuthorized(a.authorized)).catch(() => setAuthorized(false));
  }, []);
  const load = () => { if (authorized) api.reprovision.builderHosts().then(setData).catch(() => setData(null)); };
  useEffect(load, [authorized]);
  usePoll(load, 15_000);

  const short = shortHost(hostname).toLowerCase();
  const h = data?.hosts.find(x => x.host.toLowerCase() === short);
  if (!authorized || !data?.runner_enabled || !h) return null;
  const open = !!h.active_job;
  if (h.upgraded && !open) return null;

  const job = h.active_job ?? h.last_job;
  const siblings = data.hosts.filter(x => x.pool === h.pool);
  const siblingsDone = siblings.filter(x => x.upgraded).length;
  // The backend holds a second upgrade in the same pool until this one finishes.
  const poolBusy = siblings.find(x => x.host !== h.host && x.active_job && !x.active_job.params?.dry_run);

  const go = async (dryRun: boolean) => {
    setBusy(true); setErr(null);
    try { await api.reprovision.builderUpgrade(h.host, { dryRun, unquarantine }); setConfirm(false); load(); }
    catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-[0.1em] flex items-center gap-2">
          <ArrowUpCircle size={12} className={`text-emerald-400 ${open ? "animate-pulse" : ""}`} /> macOS 15 upgrade
        </h3>
        <span className="inline-flex items-center gap-1 text-[10px] text-gray-500" title="Limited to authorized operators">
          <Lock size={10} /> restricted
        </span>
      </div>

      <div className="flex items-start gap-6 flex-wrap">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm text-gray-200">
            <span className="font-mono text-gray-400">{h.os_version ?? "unknown"}</span>
            <span className="text-gray-600"> → </span>
            macOS 15, Xcode 16.4, 1500 role
          </p>
          <p className="text-[11px] text-gray-600">
            <span className="font-mono">{poolName(h.pool)}</span> · {siblingsDone} of {siblings.length} upgraded
            {poolBusy && <> · <span className="text-gray-400">{poolBusy.host.replace("macmini-", "")}</span> is upgrading, this one waits</>}
          </p>
          {job && (
            <div className="flex items-center gap-2 text-[11px] text-gray-500 min-w-0" title={job.detail ?? ""}>
              <Badge label={job.state} variant={STATE_VARIANT[job.state]} dot={open} pulse={open} />
              {job.action === "builder-upgrade"
                ? (job.params?.dry_run ? <span className="text-gray-600">check</span> : null)
                : <span className="text-gray-600">{job.action}</span>}
              <span className="truncate">{job.detail}</span>
              <span className="text-gray-600 flex-shrink-0">{ago(job.finished_at ?? job.claimed_at ?? job.created_at)}</span>
            </div>
          )}
        </div>

        {!open && !confirm && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => go(true)} disabled={busy}
              title="preflight only: T2 firmware, role, disk, autologin -- changes nothing"
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-40">
              <SearchCheck size={13} /> Check
            </button>
            <button onClick={() => setConfirm(true)}
              title="drain, macOS 15, Xcode 16.4, 1500 role, puppet, reboot"
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-100 border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-1.5 transition-colors">
              <ArrowUpCircle size={13} /> Upgrade
            </button>
          </div>
        )}
      </div>

      {confirm && (
        <div className="mt-4 rounded-lg border border-yellow-900/60 bg-yellow-950/20 p-3 space-y-2.5">
          <p className="text-xs text-yellow-100/90">
            Takes <span className="font-semibold">{h.host}</span> out of <span className="font-mono">{poolName(h.pool)}</span>{" "}
            (quarantined, drained), upgrades it to macOS 15 with Xcode 16.4, switches it to the 1500 role and reboots it.
            About 1–2 hours plus the drain. If any step fails it stays quarantined; re-queueing resumes where it stopped.
          </p>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={unquarantine} onChange={e => setUnquarantine(e.target.checked)} />
            Put it back in service when done (otherwise it stays quarantined for a look first)
          </label>
          <div className="flex items-center gap-2">
            <button onClick={() => go(false)} disabled={busy}
              className="flex items-center gap-1.5 text-xs font-semibold bg-yellow-600 hover:bg-yellow-500 text-gray-950 rounded-lg px-3 py-1.5 transition-all disabled:opacity-50">
              <ArrowUpCircle size={13} className={busy ? "animate-pulse" : ""} /> {busy ? "Queueing…" : "Yes, upgrade"}
            </button>
            <button onClick={() => setConfirm(false)} disabled={busy}
              className="text-xs text-gray-400 hover:text-gray-200 rounded-lg px-3 py-1.5 transition-all">Cancel</button>
          </div>
        </div>
      )}
      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
    </div>
  );
}
