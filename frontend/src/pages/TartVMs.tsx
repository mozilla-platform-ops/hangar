import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, ShieldCheck, AlertCircle,
  KeyRound, Server, HardDrive, Clock } from "lucide-react";
import { api } from "../api";
import type { TartSlot, TartHealthResponse } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { Badge } from "../components/Badge";
import { usePoll, useNow } from "../lib/useLive";

/**
 * Per-slot health of the tart VMs behind gecko-t-osx-1500-m-vms.
 *
 * Its own page rather than a pool row because a tart host is not a worker: each of
 * the 13 hosts runs two VMs that fail independently, and the failures that matter
 * live inside the guest. Taskcluster's view — which is what the pool tables show —
 * missed five dead slots for weeks in July 2026 because `tart run` on the host
 * stayed up the whole time.
 *
 * Data arrives from the on-network agent (`orchestrator/tart_health_agent.py`);
 * Cloud Run cannot reach MDC1, so nothing here is collected by Hangar itself.
 */

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Compact duration for uptimes measured in seconds. */
function dur(s: number | null): string {
  if (s === null) return "—";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const STATUS_VARIANT = { ok: "green", warn: "yellow", crit: "red", unknown: "gray" } as const;

// Left border accent, so a bad row is findable by colour before you read it.
const ROW_ACCENT: Record<TartSlot["status"], string> = {
  crit: "border-l-2 border-l-red-700/60",
  warn: "border-l-2 border-l-yellow-700/50",
  unknown: "border-l-2 border-l-gray-700/50",
  ok: "border-l-2 border-l-transparent",
};

function shortHost(h: string): string {
  return h.replace(/\.test\.releng\..*$/, "");
}

function Tile({ icon, label, value, hint }: {
  icon: React.ReactNode; label: string; value: string; hint?: string;
}) {
  return (
    <div className="card px-4 py-3" title={hint}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-gray-600">
        {icon} {label}
      </div>
      <div className="text-xl font-light text-white mt-1 tabular-nums">{value}</div>
    </div>
  );
}

function SlotRow({ slot, now }: { slot: TartSlot; now: number }) {
  const [open, setOpen] = useState(false);
  const expandable = slot.problems.length > 0 || slot.vm_name !== null;

  return (
    <>
      <tr
        className={`${ROW_ACCENT[slot.status]} ${expandable ? "cursor-pointer hover:bg-gray-900/40" : ""}`}
        onClick={expandable ? () => setOpen(o => !o) : undefined}
      >
        <td className="py-2 pl-2 pr-1 w-4 text-gray-600">
          {expandable && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </td>
        <td className="py-2 pr-4 font-mono text-xs text-gray-300 whitespace-nowrap">
          {shortHost(slot.hostname)}
          <span className="text-gray-600">:{slot.slot}</span>
        </td>
        <td className="py-2 pr-4 font-mono text-xs text-gray-500 whitespace-nowrap">
          {slot.worker_id ?? "—"}
        </td>
        <td className="py-2 pr-4">
          <Badge label={slot.status} variant={STATUS_VARIANT[slot.status]} dot
            pulse={slot.status === "crit"} />
        </td>
        <td className="py-2 pr-4 text-xs text-gray-500 whitespace-nowrap">
          {dur(slot.tart_run_uptime_s)}
        </td>
        <td className="py-2 pr-4 text-xs whitespace-nowrap">
          {slot.registered === null ? <span className="text-gray-600">—</span>
            : slot.registered ? <span className="text-emerald-400">registered</span>
            : <span className="text-red-400">missing</span>}
          {slot.quarantined && <span className="text-yellow-400 ml-1.5">quarantined</span>}
        </td>
        <td className="py-2 pr-4 text-xs whitespace-nowrap">
          {/* Credential-free = the host injects the worker vault at launch instead of
              the image baking it in. Per slot, because it is the rollout frontier. */}
          {slot.inject_vault ? (
            <span className="inline-flex items-center gap-1 text-brand-300"
              title="worker vault injected by the host over mTLS at launch">
              <KeyRound size={11} /> injected
            </span>
          ) : (
            <span className="text-gray-600" title="worker credentials baked into the VM image">baked</span>
          )}
        </td>
        <td className="py-2 pr-4 text-xs text-gray-600 whitespace-nowrap">
          {slot.guest_disk_free_gib !== null ? `${slot.guest_disk_free_gib} GiB` : "—"}
        </td>
        <td className="py-2 pr-2 text-xs text-gray-600 max-w-[280px] truncate">
          {slot.problems.length > 0
            ? <span className="text-gray-400">{slot.problems[0]}</span>
            : ago(slot.collected_at, now)}
        </td>
      </tr>
      {open && (
        <tr className={ROW_ACCENT[slot.status]}>
          <td />
          <td colSpan={8} className="pb-3 pr-2">
            {slot.problems.length > 0 && (
              <ul className="text-xs text-gray-400 space-y-1 mb-2">
                {slot.problems.map((p, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <AlertCircle size={12} className="mt-0.5 flex-shrink-0 text-gray-500" />
                    {p}
                  </li>
                ))}
              </ul>
            )}
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-[11px] font-mono">
              <Detail k="vm" v={slot.vm_name} />
              <Detail k="state" v={slot.vm_state} />
              <Detail k="guest up" v={slot.guest_uptime_s !== null ? dur(slot.guest_uptime_s) : null} />
              <Detail k="clock skew" v={slot.clock_skew_s !== null ? `${slot.clock_skew_s}s` : null} />
              <Detail k="configured id" v={slot.configured_worker_id} />
              <Detail k="last task" v={slot.last_task_state} />
              <Detail k="puppet" v={slot.checkout_sha ? slot.checkout_sha.slice(0, 8) : null} />
              <Detail k="cert expires" v={slot.cert_expiry ? slot.cert_expiry.slice(0, 16).replace("T", " ") : null} />
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

/** One key/value in the expanded row; renders an em dash rather than hiding a null. */
function Detail({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-gray-600">{k}</dt>
      <dd className="text-gray-400 truncate">{v ?? "—"}</dd>
    </div>
  );
}

type Filter = "all" | "problems";

export function TartVMs() {
  const [data, setData] = useState<TartHealthResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow(30_000);

  const load = () => api.tartHealth.get().then(d => { setData(d); setErr(null); }).catch(e => setErr(String(e)));
  useEffect(() => { load(); }, []);
  usePoll(load, 60_000);

  const hosts = useMemo(() => new Set(data?.slots.map(s => s.hostname) ?? []).size, [data]);
  const injected = useMemo(() => data?.slots.filter(s => s.inject_vault).length ?? 0, [data]);
  const lastCollected = useMemo(() => {
    const stamps = (data?.slots ?? []).map(s => s.collected_at).filter((s): s is string => !!s);
    return stamps.length ? stamps.sort().slice(-1)[0] : null;
  }, [data]);

  const problems = data?.slots.filter(s => s.status !== "ok") ?? [];
  const shown = filter === "problems" ? problems : (data?.slots ?? []);

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="w-1 h-9 rounded-full flex-shrink-0" style={{ backgroundImage: FF_GRADIENT }} />
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-light text-white tracking-tight">Tart VM Slots</h1>
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500 border border-gray-700/70 rounded-full px-2 py-0.5 font-mono"
                title="the only pool currently served by tart VMs">
                gecko-t-osx-1500-m-vms
              </span>
            </div>
            <p className="text-gray-500 text-sm mt-0.5">
              {data ? <>{data.total} slots across {hosts} hosts</> : "Loading…"}
              {data && <span className="text-gray-600"> · collected {ago(lastCollected, now)}</span>}
            </p>
          </div>
        </div>
        {data && (
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {data.counts.crit > 0 && <Badge label={`${data.counts.crit} crit`} variant="red" dot pulse />}
            {data.counts.warn > 0 && <Badge label={`${data.counts.warn} warn`} variant="yellow" dot />}
            {data.counts.unknown > 0 && <Badge label={`${data.counts.unknown} unknown`} variant="gray" dot />}
            <Badge label={`${data.counts.ok}/${data.total} ok`}
              variant={data.counts.ok === data.total ? "green" : "gray"}
              dot={data.counts.ok === data.total} />
          </div>
        )}
      </div>

      {err && !data && (
        <div className="card p-5 text-sm text-gray-500">Couldn't load tart slot health: {err}</div>
      )}

      {!err && !data && (
        <div className="card p-5 text-sm text-gray-600 flex items-center gap-2">
          <LoaderCircle size={14} className="animate-spin" /> Loading slot health…
        </div>
      )}

      {data && data.total === 0 && (
        <div className="card p-5 text-sm text-gray-500">
          No slot health has been collected yet. The on-network agent
          (<span className="font-mono text-xs">orchestrator/tart_health_agent.py</span>) pushes
          it from inside MDC1 — Hangar cannot reach the hosts itself.
        </div>
      )}

      {data && data.total > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile icon={<Server size={11} />} label="Slots" value={`${data.total}`}
              hint={`${hosts} hosts × 2 VMs`} />
            <Tile icon={<ShieldCheck size={11} />} label="Healthy" value={`${data.counts.ok}/${data.total}`} />
            <Tile icon={<KeyRound size={11} />} label="Credential-free" value={`${injected}/${data.total}`}
              hint="slots whose worker vault is injected by the host at launch rather than baked into the image" />
            <Tile icon={<Clock size={11} />} label="Last collected" value={ago(lastCollected, now)}
              hint="slots go to 'unknown' after 30 minutes without a push" />
          </div>

          {problems.length === 0 && (
            <div className="card p-4 text-sm text-gray-400 flex items-center gap-2">
              <ShieldCheck size={15} className="text-emerald-400 flex-shrink-0" />
              All {data.total} slots healthy across {hosts} hosts.
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800/60">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                {filter === "problems" ? `${problems.length} needing attention` : "All slots"}
              </span>
              <div className="flex items-center gap-1">
                {(["all", "problems"] as Filter[]).map(f => (
                  <button key={f} onClick={() => setFilter(f)}
                    disabled={f === "problems" && problems.length === 0}
                    className={`text-[11px] px-2 py-0.5 rounded-md transition-colors ${
                      filter === f ? "bg-brand-500/10 text-brand-300"
                        : "text-gray-600 hover:text-gray-300 disabled:hover:text-gray-600 disabled:opacity-40"
                    }`}>
                    {f === "all" ? `All ${data.total}` : `Problems ${problems.length}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-gray-600 border-b border-gray-800/60">
                    <th />
                    <th className="py-2 pr-4 font-medium">Slot</th>
                    <th className="py-2 pr-4 font-medium">Worker</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium" title="how long the host's `tart run` process has been up">Run up</th>
                    <th className="py-2 pr-4 font-medium">Taskcluster</th>
                    <th className="py-2 pr-4 font-medium">Creds</th>
                    <th className="py-2 pr-4 font-medium">Guest free</th>
                    <th className="py-2 pr-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {shown.map(s => <SlotRow key={`${s.hostname}-${s.slot}`} slot={s} now={now} />)}
                </tbody>
              </table>
            </div>
          </div>

          {/* Stated plainly, because a monitoring page that quietly under-reports its
              own coverage is how the July outage stayed invisible. */}
          <p className="text-[11px] text-gray-600 flex items-start gap-1.5 max-w-3xl">
            <HardDrive size={12} className="mt-0.5 flex-shrink-0" />
            Guest-level checks — disk headroom, clock skew, worker identity — are only
            populated when the agent runs with guest probes enabled. Without them these
            columns stay blank and a VM crash-looping inside a healthy host will still
            read as <span className="font-mono">ok</span>.
          </p>
        </>
      )}
    </div>
  );
}

export default TartVMs;
