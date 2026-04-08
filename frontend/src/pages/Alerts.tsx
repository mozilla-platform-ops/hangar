import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Eye } from "lucide-react";
import { api } from "../api";
import type { Alert } from "../api";
import { Badge } from "../components/Badge";

const TYPE_LABELS: Record<string, { label: string; color: "red" | "orange" | "yellow" | "gray" }> = {
  missing_from_tc:  { label: "Missing from TC",   color: "red" },
  quarantined:      { label: "Quarantined",        color: "orange" },
  mdm_unenrolled:   { label: "MDM Unenrolled",     color: "yellow" },
  pool_mismatch:    { label: "Pool Mismatch",      color: "gray" },
};

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.round(diff / 36e5);
  if (hrs < 1) return "<1h ago";
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function isSigningWorker(hostname: string) {
  return !hostname.startsWith("macmini-");
}

export function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeOnly, setActiveOnly] = useState(true);
  const [hideSigningWorkers, setHideSigningWorkers] = useState(true);
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    try {
      const data = await api.alerts.list(activeOnly);
      setAlerts(data.alerts);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [activeOnly]);

  async function resolve(id: number) {
    await api.alerts.resolve(id);
    setAlerts(prev => prev.filter(a => a.id !== id));
    setTotal(t => t - 1);
  }

  async function acknowledge(id: number) {
    await api.alerts.acknowledge(id);
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged: true } : a));
  }

  const visibleAlerts = hideSigningWorkers
    ? alerts.filter(a => !isSigningWorker(a.hostname))
    : alerts;

  const byType = visibleAlerts.reduce<Record<string, number>>((acc, a) => {
    acc[a.alert_type] = (acc[a.alert_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <AlertTriangle size={22} className="text-red-400" /> Alerts
          </h1>
          <p className="text-gray-400 text-sm mt-1">
            {visibleAlerts.length}{total !== visibleAlerts.length ? ` of ${total}` : ""} {activeOnly ? "active" : "total"} alerts
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" checked={hideSigningWorkers} onChange={e => setHideSigningWorkers(e.target.checked)} className="accent-brand-500" />
            Hide signing workers
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="accent-brand-500" />
            Active only
          </label>
        </div>
      </div>

      {/* Summary by type */}
      {Object.keys(byType).length > 0 && (
        <div className="flex flex-wrap gap-3">
          {Object.entries(byType).map(([type, count]) => {
            const cfg = TYPE_LABELS[type] || { label: type, color: "gray" as const };
            return (
              <div key={type} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-3">
                <Badge label={cfg.label} variant={cfg.color} />
                <span className="text-2xl font-bold text-white">{count}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Alert list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : visibleAlerts.length === 0 ? (
          <div className="p-12 text-center">
            <CheckCircle2 size={40} className="text-emerald-400 mx-auto mb-3" />
            <div className="text-lg font-medium text-gray-300">All clear!</div>
            <div className="text-sm text-gray-500 mt-1">No active alerts</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {["Type", "Worker", "Pool", "Detail", "Since", "Actions"].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleAlerts.map(alert => {
                const cfg = TYPE_LABELS[alert.alert_type] || { label: alert.alert_type, color: "gray" as const };
                return (
                  <tr key={alert.id} className={`border-b border-gray-800/50 ${alert.acknowledged ? "opacity-60" : ""}`}>
                    <td className="px-4 py-3">
                      <Badge label={cfg.label} variant={cfg.color} />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        className="text-brand-400 hover:text-brand-300 font-mono text-xs block"
                        onClick={() => navigate(`/workers/${alert.hostname}`)}
                      >
                        {alert.hostname.split(".")[0]}
                      </button>
                      {alert.worker?.generation && (
                        <span className="text-xs text-gray-500">{alert.worker.generation}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                      {alert.worker?.worker_pool?.replace(/^gecko-t-osx-\d+-/, "") || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{alert.detail || "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{timeAgo(alert.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {!alert.acknowledged && (
                          <button
                            className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-white"
                            title="Acknowledge"
                            onClick={() => acknowledge(alert.id)}
                          >
                            <Eye size={14} />
                          </button>
                        )}
                        <button
                          className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-emerald-400"
                          title="Resolve"
                          onClick={() => resolve(alert.id)}
                        >
                          <CheckCircle2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
