import { useEffect, useState } from "react";
import { ArrowUpCircle, LoaderCircle, SearchCheck } from "lucide-react";
import { api } from "../api";
import type { BuilderUpgradeHost, ReprovisionJob } from "../api";
import { Badge } from "./Badge";
import { usePoll } from "../lib/useLive";

/**
 * Intel r8 builders 10.15 -> macOS 15, in place: the on-network runner drains the worker, runs
 * startosinstall, installs Xcode 16.4, switches to the 1500 role, converges puppet, restores
 * autologin and reboots (relops-bootstrap `reprovision builder-upgrade`). One upgrade per pool at
 * a time, and never a pool's last in-service worker; the backend enforces both. Hosts with a T2
 * below 20P are refused by the runner's preflight (they need a DFU revive first) -- "Check" runs
 * just that preflight. Shown only to the reprovision allowlist, and only when a runner is wired up.
 */

const STATE_VARIANT: Record<ReprovisionJob["state"], "green" | "red" | "yellow" | "blue" | "gray"> = {
  queued: "gray", claimed: "blue", running: "blue", succeeded: "green", failed: "red", canceled: "gray",
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function Row({ h, onQueued }: { h: BuilderUpgradeHost; onQueued: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [unquarantine, setUnquarantine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const job = h.active_job ?? h.last_job;
  const open = !!h.active_job;

  const go = async (dryRun: boolean) => {
    setBusy(true); setErr(null);
    try { await api.reprovision.builderUpgrade(h.host, { dryRun, unquarantine }); setConfirm(false); onQueued(); }
    catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="py-2.5 border-t border-gray-800/60 first:border-t-0">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm text-gray-200 w-28 flex-shrink-0">{h.host.replace("macmini-", "")}</span>
        <span className={`font-mono text-xs w-16 flex-shrink-0 ${h.upgraded ? "text-green-400" : "text-gray-500"}`}>
          {h.os_version ?? "?"}
        </span>
        <div className="flex-1 min-w-0 text-xs text-gray-500 truncate" title={job?.detail ?? ""}>
          {job ? (
            <span className="inline-flex items-center gap-2 min-w-0">
              <Badge label={job.state} variant={STATE_VARIANT[job.state]} dot={open} pulse={open} />
              {job.action === "builder-upgrade" ? (job.params?.dry_run ? <span className="text-gray-600">check</span> : "")
                : <span className="text-gray-600">{job.action}</span>}
              <span className="truncate">{job.detail}</span>
              <span className="text-gray-600 flex-shrink-0">{ago(job.finished_at ?? job.claimed_at ?? job.created_at)}</span>
            </span>
          ) : h.quarantined ? <span className="text-yellow-600">quarantined</span> : null}
        </div>
        {h.upgraded ? (
          <span className="text-[11px] text-green-500/80 flex-shrink-0">on macOS 15</span>
        ) : !confirm && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button onClick={() => go(true)} disabled={open || busy}
              title={open ? "a job is already open for this host" : "preflight only: T2 firmware, role, disk, autologin -- changes nothing"}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 rounded-lg px-2 py-1 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              <SearchCheck size={12} /> Check
            </button>
            <button onClick={() => setConfirm(true)} disabled={open}
              title={open ? "a job is already open for this host" : "drain, macOS 15, Xcode 16.4, 1500 role, puppet, reboot"}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-200 border border-gray-700 hover:border-gray-500 rounded-lg px-2.5 py-1 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              <ArrowUpCircle size={12} /> Upgrade
            </button>
          </div>
        )}
      </div>
      {confirm && (
        <div className="mt-2 rounded-lg border border-yellow-900/60 bg-yellow-950/20 p-3 space-y-2.5">
          <p className="text-xs text-yellow-100/90">
            Takes <span className="font-semibold">{h.host}</span> out of <span className="font-mono">{h.pool.split("/")[1]}</span>{" "}
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
      {err && <p className="mt-1.5 text-xs text-red-400">{err}</p>}
    </div>
  );
}

export function BuilderUpgrades() {
  const [authorized, setAuthorized] = useState(false);
  const [data, setData] = useState<{ hosts: BuilderUpgradeHost[]; runner_enabled: boolean } | null>(null);

  useEffect(() => {
    api.reprovision.access().then(a => setAuthorized(a.authorized)).catch(() => setAuthorized(false));
  }, []);
  const load = () => { if (authorized) api.reprovision.builderHosts().then(setData).catch(() => setData(null)); };
  useEffect(load, [authorized]);
  usePoll(load, 30_000);

  if (!authorized || !data?.runner_enabled) return null;
  const pools = [...new Set(data.hosts.map(h => h.pool))];
  const done = data.hosts.filter(h => h.upgraded).length;
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-200">Builders → macOS 15</h2>
        <span className="text-[11px] text-gray-600">{done}/{data.hosts.length} upgraded · one per pool at a time · on-network runner</span>
      </div>
      {data.hosts.length === 0
        ? <p className="text-xs text-gray-600 flex items-center gap-2"><LoaderCircle size={12} className="animate-spin" /> No builders synced yet</p>
        : pools.map(pool => (
          <div key={pool} className="mt-3 first:mt-0">
            <div className="text-[11px] font-mono text-gray-500 mb-1">{pool.split("/")[1]}</div>
            {data.hosts.filter(h => h.pool === pool).map(h => <Row key={h.host} h={h} onQueued={load} />)}
          </div>
        ))}
    </div>
  );
}
