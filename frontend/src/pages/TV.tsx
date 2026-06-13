import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Worker, LoadHistory, AlertListResponse } from "../api";
import { api } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { usePoll, useNow } from "../lib/useLive";
import { isSigningWorker } from "../lib/alerts";
import { fleetCounts } from "../lib/health";
import { FleetHeatmap, HeatmapLegend } from "../components/FleetHeatmap";
import { Sparkline } from "../components/Sparkline";

/** Chromeless full-screen dashboard for an office wall monitor. Big type, dark,
 *  self-refreshing — nothing makes a dashboard stickier than being mounted on a wall. */
export function TV() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [load, setLoad] = useState<LoadHistory | null>(null);
  const [alerts, setAlerts] = useState<AlertListResponse | null>(null);
  const now = useNow(1_000);

  const refresh = (silent = false) => {
    api.workers.list({ limit: 2000 }).then(d => setWorkers(d.workers)).catch(() => {});
    api.fleet.loadHistory(48).then(setLoad).catch(() => {});
    api.alerts.list(true).then(setAlerts).catch(() => {});
    void silent;
  };
  useEffect(() => refresh(), []);
  usePoll(() => refresh(true), 30_000);

  const counts = fleetCounts(workers);
  const totals = load?.totals ?? [];
  const curPending = totals.length ? totals[totals.length - 1].pending : null;
  const curRunning = totals.length ? totals[totals.length - 1].running : null;
  const activeAlerts = (alerts?.alerts ?? []).filter(a => !isSigningWorker(a));
  const clock = now ? new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div className="flex items-center gap-4">
          <span className="w-1.5 h-12 rounded-full" style={{ backgroundImage: FF_GRADIENT }} />
          <div>
            <div className="text-3xl font-light tracking-tight bg-clip-text text-transparent" style={{ backgroundImage: FF_GRADIENT }}>
              Hangar Fleet
            </div>
            <div className="text-sm text-gray-500 mt-1">{workers.length.toLocaleString()} workers across {new Set(workers.map(w => w.worker_pool)).size} pools</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-4xl font-light tabular-nums text-gray-200">{clock}</div>
          <div className="text-xs text-gray-600 mt-1 flex items-center justify-end gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> live · refreshes every 30s
          </div>
        </div>
      </div>

      {/* Top stats row */}
      <div className="grid grid-cols-4 gap-5">
        <Stat label="Pending tasks" value={curPending} accent />
        <Stat label="Running" value={curRunning} />
        <Stat label="Healthy workers" value={counts.healthy} color="#34d399" />
        <Stat label="Active alerts" value={activeAlerts.length} color={activeAlerts.length ? "#f87171" : "#34d399"} />
      </div>

      {/* Load sparkline */}
      {totals.length >= 2 && (
        <div className="card p-5">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Fleet load · last {load?.hours}h</div>
          <Sparkline points={totals.map(t => t.pending)} className="w-full h-20" animate={false} />
        </div>
      )}

      {/* Heatmap fills the rest */}
      <div className="card p-5 flex-1 overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Fleet health · worst pools first</div>
          <HeatmapLegend counts={counts} />
        </div>
        {workers.length > 0
          ? <FleetHeatmap workers={workers} cell={15} gap={3} interactive={false} />
          : <div className="py-12 text-center text-gray-600">Loading fleet…</div>}
      </div>

      {/* Alert ticker */}
      {activeAlerts.length > 0 && (
        <div className="card card-glow-red p-4 flex items-center gap-4 flex-shrink-0">
          <AlertTriangle size={20} className="text-red-400 flex-shrink-0" />
          <div className="flex gap-6 overflow-x-auto">
            {activeAlerts.slice(0, 12).map(a => (
              <span key={a.id} className="text-sm whitespace-nowrap">
                <span className="font-mono text-gray-300">{a.hostname.split(".")[0]}</span>
                <span className="text-red-400/80 ml-2">{a.alert_type.replace(/_/g, " ")}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent, color }: { label: string; value: number | null; accent?: boolean; color?: string }) {
  return (
    <div className="card p-5">
      <div
        className="text-5xl font-bold tabular-nums leading-none"
        style={accent ? { backgroundImage: FF_GRADIENT, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }
                      : color ? { color } : undefined}
      >
        {value === null ? "—" : value.toLocaleString()}
      </div>
      <div className="text-xs text-gray-500 uppercase tracking-wider mt-3">{label}</div>
    </div>
  );
}
