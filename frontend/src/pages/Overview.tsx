import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Monitor, Server, Activity, Clock, GitBranch, ShieldOff } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Legend } from "recharts";
import { api } from "../api";
import type { FleetSummary } from "../api";

const PIE_COLORS: Record<string, string> = {
  production: "#10b981", staging: "#3b82f6", loaner: "#a855f7",
  defective: "#ef4444", spare: "#f59e0b", unknown: "#374151",
};
const GEN_COLORS: Record<string, string> = {
  r8: "#6366f1", m2: "#06b6d4", m4: "#10b981", unknown: "#374151",
};

const TOOLTIP_STYLE = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 8,
  fontSize: 12,
  color: "#e5e7eb",
  boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
};

type CardColor = "blue" | "green" | "red" | "yellow";

const CARD_STYLES: Record<CardColor, { border: string; accent: string; icon: string; glow: string }> = {
  blue:   { border: "border-blue-800/40",   accent: "bg-blue-500",   icon: "text-blue-400",   glow: "card-glow-blue" },
  green:  { border: "border-emerald-800/40", accent: "bg-emerald-500", icon: "text-emerald-400", glow: "card-glow-green" },
  red:    { border: "border-red-800/40",     accent: "bg-red-500",     icon: "text-red-400",     glow: "card-glow-red" },
  yellow: { border: "border-yellow-800/40",  accent: "bg-yellow-500",  icon: "text-yellow-400",  glow: "card-glow-yellow" },
};

function StatCard({ icon: Icon, label, value, sub, color = "blue", to }:
  { icon: typeof Monitor; label: string; value: string | number; sub?: string; color?: CardColor; to?: string }) {
  const s = CARD_STYLES[color];
  const inner = (
    <div className={`relative rounded-xl border bg-gray-900/80 p-5 flex flex-col gap-3 overflow-hidden group transition-all duration-200 hover:border-opacity-60 ${s.border} ${s.glow}`}>
      {/* Accent bar */}
      <div className={`absolute top-0 left-0 right-0 h-0.5 ${s.accent} opacity-60`} />
      <div className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wider opacity-60 ${s.icon}`}>
        <Icon size={13} /> {label}
      </div>
      <div className="text-4xl font-bold text-white tabular-nums">{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
      {to && <div className={`text-xs ${s.icon} opacity-0 group-hover:opacity-100 transition-opacity`}>View →</div>}
    </div>
  );
  return to ? <Link to={to} className="block">{inner}</Link> : inner;
}

function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function SyncDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${ok ? "bg-emerald-400" : "bg-gray-600"}`} />
  );
}

export function Overview() {
  const [data, setData] = useState<FleetSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.fleet.summary().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="p-8 text-red-400 text-sm">{error}</div>;
  if (!data) return (
    <div className="p-8 flex items-center gap-3 text-gray-500 text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
      Loading fleet data…
    </div>
  );

  const stateData = Object.entries(data.by_state).map(([name, value]) => ({ name, value }));
  const genData = Object.entries(data.by_generation).map(([name, value]) => ({ name, value }));
  const topPools = Object.entries(data.by_pool).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, value]) => ({ name, value }));

  const totalAlerts = data.alerts.quarantined + data.alerts.missing_from_tc + data.alerts.mdm_unenrolled;

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Fleet Overview</h1>
          <p className="text-gray-500 text-sm mt-0.5">macOS CI worker fleet · real-time</p>
        </div>
        {totalAlerts > 0 && (
          <Link to="/alerts" className="flex items-center gap-2 bg-red-950/60 border border-red-800/50 text-red-300 text-xs font-medium px-3 py-1.5 rounded-lg hover:bg-red-950 transition-colors">
            <AlertTriangle size={12} />
            {totalAlerts} active alert{totalAlerts !== 1 ? "s" : ""}
          </Link>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Monitor} label="Total Workers" value={data.total_workers} color="blue" />
        <StatCard icon={Server} label="Production" value={data.by_state.production || 0} color="green" to="/workers?state=production" />
        <StatCard icon={ShieldOff} label="Quarantined" value={data.alerts.quarantined_non_staging} color="red" to="/workers?tc_quarantined=true" />
        <StatCard icon={Activity} label="Active Alerts" value={totalAlerts} color="red" to="/alerts" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">By State</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={stateData} cx="50%" cy="50%" innerRadius={52} outerRadius={80} dataKey="value" paddingAngle={3} strokeWidth={0}>
                {stateData.map(entry => (
                  <Cell key={entry.name} fill={PIE_COLORS[entry.name] || "#374151"} />
                ))}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "#e5e7eb" }} />
              <Legend iconType="circle" iconSize={7} formatter={val => <span className="text-xs text-gray-400">{val}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">By Generation</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={genData} cx="50%" cy="50%" innerRadius={52} outerRadius={80} dataKey="value" paddingAngle={3} strokeWidth={0}>
                {genData.map(entry => (
                  <Cell key={entry.name} fill={GEN_COLORS[entry.name] || "#374151"} />
                ))}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "#e5e7eb" }} />
              <Legend iconType="circle" iconSize={7} formatter={val => <span className="text-xs text-gray-400">{val}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">Top Pools</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={topPools} layout="vertical" margin={{ left: 4, right: 16, top: 0, bottom: 0 }}>
              <XAxis type="number" tick={{ fontSize: 10, fill: "#6b7280" }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={96} interval={0} tick={{ fontSize: 10, fill: "#9ca3af", fontFamily: "JetBrains Mono, monospace" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "#e5e7eb" }} cursor={{ fill: "#ffffff08" }} />
              <Bar dataKey="value" fill="#4c6ef5" radius={[0, 4, 4, 0]} maxBarSize={12} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Branch overrides */}
      {data.branch_overrides?.total > 0 && (
        <div className="card p-5">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
            <GitBranch size={12} /> Branch Overrides
            <span className="ml-1 text-amber-400 font-bold">{data.branch_overrides.total}</span>
            <span className="text-gray-600 font-normal">workers pinned to a non-default branch</span>
          </h3>
          <div className="flex flex-wrap gap-6">
            {/* By branch */}
            <div>
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">By Branch</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.branch_overrides.by_branch)
                  .sort((a, b) => b[1] - a[1])
                  .map(([branch, count]) => (
                    <div key={branch} className="flex items-center gap-2 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-1.5">
                      <GitBranch size={10} className="text-amber-500" />
                      <span className="text-xs font-mono text-amber-300">{branch}</span>
                      <span className="text-xs font-bold text-white tabular-nums">{count}</span>
                    </div>
                  ))
                }
              </div>
            </div>
            {/* By pool */}
            <div>
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">By Pool</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.branch_overrides.by_pool)
                  .sort((a, b) => b[1] - a[1])
                  .map(([pool, count]) => (
                    <div key={pool} className="flex items-center gap-2 bg-gray-800/40 border border-gray-700/40 rounded-lg px-3 py-1.5">
                      <span className="text-xs font-mono text-gray-400">{pool}</span>
                      <span className="text-xs font-bold text-amber-400 tabular-nums">{count}</span>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-gray-800/60">
            <Link to="/workers?branch=set" className="text-xs text-brand-400 hover:text-brand-300 transition-colors">
              View affected workers →
            </Link>
          </div>
        </div>
      )}

      {/* Sync status */}
      <div className="card p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
          <Clock size={12} /> Sync Status
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Object.entries(data.sync_status).map(([source, status]) => (
            <div key={source} className="bg-gray-800/40 rounded-lg p-3 border border-gray-700/40">
              <div className="flex items-center gap-2 mb-2">
                <SyncDot ok={!!status.last_success} />
                <span className="text-xs text-gray-400 font-medium capitalize">{source}</span>
              </div>
              <div className="text-sm font-medium text-white">{timeAgo(status.last_success)}</div>
              {status.records_updated !== null && (
                <div className="text-xs text-gray-600 mt-0.5">{status.records_updated.toLocaleString()} records</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
