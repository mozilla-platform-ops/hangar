import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Monitor, Server, Activity, Clock } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend } from "recharts";
import { api } from "../api";
import type { FleetSummary } from "../api";

const PIE_COLORS: Record<string, string> = {
  production: "#10b981", staging: "#3b82f6", loaner: "#a855f7",
  defective: "#ef4444", spare: "#f59e0b", unknown: "#6b7280",
};
const GEN_COLORS: Record<string, string> = { r8: "#6366f1", m2: "#06b6d4", m4: "#10b981", unknown: "#6b7280" };

function StatCard({ icon: Icon, label, value, sub, color = "blue", to }:
  { icon: typeof Monitor; label: string; value: string | number; sub?: string; color?: string; to?: string }) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-500/10 text-blue-400 border-blue-800/40",
    green: "bg-emerald-500/10 text-emerald-400 border-emerald-800/40",
    red: "bg-red-500/10 text-red-400 border-red-800/40",
    yellow: "bg-yellow-500/10 text-yellow-400 border-yellow-800/40",
    purple: "bg-purple-500/10 text-purple-400 border-purple-800/40",
  };
  const content = (
    <div className={`rounded-xl border p-5 flex flex-col gap-2 ${colorMap[color] || colorMap.blue}`}>
      <div className="flex items-center gap-2 text-sm font-medium opacity-70">
        <Icon size={14} /> {label}
      </div>
      <div className="text-3xl font-bold">{value}</div>
      {sub && <div className="text-xs opacity-60">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{content}</Link> : content;
}

function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function Overview() {
  const [data, setData] = useState<FleetSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.fleet.summary().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="p-8 text-red-400">{error}</div>;
  if (!data) return <div className="p-8 text-gray-400">Loading…</div>;

  const stateData = Object.entries(data.by_state).map(([name, value]) => ({ name, value }));
  const genData = Object.entries(data.by_generation).map(([name, value]) => ({ name, value }));
  const topPools = Object.entries(data.by_pool).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, value]) => ({ name: name.replace("gecko-t-", "").replace("-r8", "").replace("-m4", ""), value }));

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Fleet Overview</h1>
        <p className="text-gray-400 text-sm mt-1">Real-time status across all macOS CI workers</p>
      </div>

      {/* Alert banners */}
      {(data.alerts.quarantined > 0 || data.alerts.missing_from_tc > 0 || data.alerts.mdm_unenrolled > 0) && (
        <div className="rounded-xl bg-red-950/40 border border-red-800/50 p-4 flex items-center gap-3">
          <AlertTriangle size={18} className="text-red-400 flex-shrink-0" />
          <div className="text-sm text-red-300 flex gap-4 flex-wrap">
            {data.alerts.quarantined > 0 && <span><strong>{data.alerts.quarantined}</strong> quarantined</span>}
            {data.alerts.missing_from_tc > 0 && <span><strong>{data.alerts.missing_from_tc}</strong> missing from TC</span>}
            {data.alerts.mdm_unenrolled > 0 && <span><strong>{data.alerts.mdm_unenrolled}</strong> MDM unenrolled</span>}
          </div>
          <Link to="/alerts" className="ml-auto text-xs text-red-400 hover:text-red-200 underline">View alerts →</Link>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Monitor} label="Total Workers" value={data.total_workers} color="blue" />
        <StatCard icon={Server} label="Production" value={data.by_state.production || 0} color="green" to="/workers?state=production" />
        <StatCard icon={AlertTriangle} label="Defective / Spare" value={(data.by_state.defective || 0) + (data.by_state.spare || 0)} color="yellow" />
        <StatCard icon={Activity} label="Active Alerts" value={data.alerts.quarantined + data.alerts.missing_from_tc + data.alerts.mdm_unenrolled} color="red" to="/alerts" />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* By state pie */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">By State</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={stateData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" paddingAngle={2}>
                {stateData.map(entry => (
                  <Cell key={entry.name} fill={PIE_COLORS[entry.name] || "#6b7280"} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 8 }} />
              <Legend formatter={val => <span className="text-xs text-gray-400">{val}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* By generation pie */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">By Generation</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={genData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" paddingAngle={2}>
                {genData.map(entry => (
                  <Cell key={entry.name} fill={GEN_COLORS[entry.name] || "#6b7280"} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 8 }} />
              <Legend formatter={val => <span className="text-xs text-gray-400">{val}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Top pools bar */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">Top Pools (by count)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={topPools} layout="vertical" margin={{ left: 0, right: 12, top: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} />
              <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 9, fill: "#9ca3af" }} />
              <Tooltip contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 8 }} />
              <Bar dataKey="value" fill="#4c6ef5" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Sync status */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2"><Clock size={14} /> Sync Status</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Object.entries(data.sync_status).map(([source, status]) => (
            <div key={source} className="bg-gray-800/50 rounded-lg p-3">
              <div className="text-xs text-gray-400 capitalize font-medium">{source}</div>
              <div className="text-sm text-white mt-1">{timeAgo(status.last_success)}</div>
              {status.records_updated !== null && (
                <div className="text-xs text-gray-500">{status.records_updated} records</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
