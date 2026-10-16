import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, Wrench } from "lucide-react";
import { api } from "../api";
import type { ReprovisionJob, TartHostMaintenance } from "../api";
import { Badge } from "./Badge";
import { usePoll } from "../lib/useLive";

/**
 * One-click maintenance for tart VM hosts: the on-network runner drains both VMs, minor-updates
 * macOS via SimpleMDM, applies tart_worker, reboots, and puts the host back in service
 * (relops-bootstrap `reprovision tart-host-update`). One host at a time; the runner enforces it.
 * Shown only to the reprovision allowlist, and only when a runner is wired up.
 */

const STATE_VARIANT: Record<ReprovisionJob["state"], "green" | "red" | "yellow" | "blue" | "gray"> = {
  queued: "gray", claimed: "blue", running: "blue", succeeded: "green", failed: "red", canceled: "gray",
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function Row({ h, onQueued }: { h: TartHostMaintenance; onQueued: () => void }) {
  const [confirm, setConfirm] = useState<null | "full" | "puppet">(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const job = h.active_job ?? h.last_job;
  const open = !!h.active_job;

  const go = async (puppetOnly: boolean) => {
    setBusy(true); setErr(null);
    try { await api.reprovision.tartUpdate(h.host, puppetOnly); setConfirm(null); onQueued(); }
    catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="py-2.5 border-t border-gray-800/60 first:border-t-0">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm text-gray-200 w-40 flex-shrink-0">{h.host.replace("macmini-", "")}</span>
        <div className="flex-1 min-w-0 text-xs text-gray-500 truncate" title={job?.detail ?? ""}>
          {job ? (
            <span className="inline-flex items-center gap-2 min-w-0">
              <Badge label={job.state} variant={STATE_VARIANT[job.state]} dot={open} pulse={open} />
              {job.action === "tart-host-update" ? "" : <span className="text-gray-600">{job.action}</span>}
              <span className="truncate">{job.detail}</span>
              <span className="text-gray-600 flex-shrink-0">{ago(job.finished_at ?? job.claimed_at ?? job.created_at)}</span>
            </span>
          ) : <span className="text-gray-600">no maintenance runs yet</span>}
        </div>
        {h.excluded ? (
          <span className="text-[11px] text-gray-600 flex-shrink-0" title={h.excluded}>excluded</span>
        ) : !confirm && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button onClick={() => setConfirm("full")} disabled={open}
              title={open ? "a job is already open for this host" : "drain, macOS minor update, puppet, reboot, verify"}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-200 border border-gray-700 hover:border-gray-500 rounded-lg px-2.5 py-1 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              <Wrench size={12} /> Update host
            </button>
            <button onClick={() => setConfirm("puppet")} disabled={open}
              title={open ? "a job is already open for this host" : "drain, puppet, reboot only if needed, verify -- no OS update"}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 rounded-lg px-2 py-1 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              <RefreshCw size={12} /> Puppet only
            </button>
          </div>
        )}
      </div>
      {confirm && (
        <div className="mt-2 rounded-lg border border-yellow-900/60 bg-yellow-950/20 p-3 space-y-2.5">
          <p className="text-xs text-yellow-100/90">
            Takes <span className="font-semibold">{h.host}</span> out of service (both VMs drained and quarantined),
            {confirm === "full" ? " applies the latest macOS 15 minor update via SimpleMDM," : ""} applies tart_worker from master,
            reboots, then puts it back. {confirm === "full" ? "About 30–120 min." : "A few minutes."} If any step fails the VMs stay quarantined.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => go(confirm === "puppet")} disabled={busy}
              className="flex items-center gap-1.5 text-xs font-semibold bg-yellow-600 hover:bg-yellow-500 text-gray-950 rounded-lg px-3 py-1.5 transition-all disabled:opacity-50">
              <Wrench size={13} className={busy ? "animate-pulse" : ""} /> {busy ? "Queueing…" : confirm === "full" ? "Yes, update" : "Yes, puppet only"}
            </button>
            <button onClick={() => setConfirm(null)} disabled={busy}
              className="text-xs text-gray-400 hover:text-gray-200 rounded-lg px-3 py-1.5 transition-all">Cancel</button>
          </div>
        </div>
      )}
      {err && <p className="mt-1.5 text-xs text-red-400">{err}</p>}
    </div>
  );
}

export function TartMaintenance() {
  const [authorized, setAuthorized] = useState(false);
  const [data, setData] = useState<{ hosts: TartHostMaintenance[]; runner_enabled: boolean } | null>(null);

  useEffect(() => {
    api.reprovision.access().then(a => setAuthorized(a.authorized)).catch(() => setAuthorized(false));
  }, []);
  const load = () => { if (authorized) api.reprovision.tartHosts().then(setData).catch(() => setData(null)); };
  useEffect(load, [authorized]);
  usePoll(load, 30_000);

  if (!authorized || !data?.runner_enabled) return null;
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-200">Host maintenance</h2>
        <span className="text-[11px] text-gray-600">one host at a time · runs on the on-network runner</span>
      </div>
      {data.hosts.length === 0
        ? <p className="text-xs text-gray-600 flex items-center gap-2"><LoaderCircle size={12} className="animate-spin" /> No tart hosts reported yet</p>
        : data.hosts.map(h => <Row key={h.host} h={h} onQueued={load} />)}
    </div>
  );
}
