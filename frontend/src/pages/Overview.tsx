import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Monitor, Server, Activity, Clock, GitBranch, ShieldOff, Cpu, FlaskConical } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from "recharts";
import { api } from "../api";
import type { FleetSummary, FailureInsights } from "../api";

const PRIORITY_POOLS = [
  { name: "gecko-t-osx-1400-r8", short: "1400-r8", color: "#6366f1", os: "macOS 14.7.5",  arch: "Intel · Sonoma" },
  { name: "gecko-t-osx-1015-r8", short: "1015-r8", color: "#a78bfa", os: "macOS 10.15.7", arch: "Intel · Catalina" },
  { name: "gecko-t-osx-1500-m4", short: "1500-m4", color: "#10b981", os: "macOS 15.3",    arch: "Apple Silicon" },
];

const STAGING_POOLS = [
  { name: "gecko-t-osx-1400-r8-staging", short: "1400-r8", color: "#4338ca", os: "macOS 14.7.5",  arch: "Intel · Sonoma" },
  { name: "gecko-t-osx-1015-r8-staging", short: "1015-r8", color: "#7c3aed", os: "macOS 10.15.7", arch: "Intel · Catalina" },
  { name: "gecko-t-osx-1500-m4-staging", short: "1500-m4", color: "#059669", os: "macOS 15.3",    arch: "Apple Silicon" },
];

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

function shortTaskName(name: string): string {
  const slash = name.lastIndexOf("/");
  const part = slash >= 0 ? name.slice(slash + 1) : name;
  return part.replace(/^(opt|debug|ccov|asan|tsan)-/, "");
}

function shortPool(pool: string | null): string {
  if (!pool) return "?";
  return pool.replace(/^gecko-[tb]-osx-/, "").replace(/^gecko-\d+-[tb]-osx-/, "");
}

function SyncDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${ok ? "bg-emerald-400" : "bg-gray-600"}`} />;
}

const FAILURE_PLATFORMS = [
  { key: "",      label: "All" },
  { key: "mac",   label: "macOS" },
  { key: "linux", label: "Linux" },
];

export function Overview() {
  const [data, setData] = useState<FleetSummary | null>(null);
  const [failures, setFailures] = useState<FailureInsights | null>(null);
  const [failurePlatform, setFailurePlatform] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.fleet.summary().then(setData).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    setFailures(null);
    api.fleet.failures(7, failurePlatform || undefined).then(setFailures).catch(() => {});
  }, [failurePlatform]);

  if (error) return <div className="p-8 text-red-400 text-sm">{error}</div>;
  if (!data) return (
    <div className="p-8 flex items-center gap-3 text-gray-500 text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
      Loading fleet data…
    </div>
  );

  const priorityPoolData = PRIORITY_POOLS.map(p => ({ name: p.short, value: data.by_pool[p.name] || 0, color: p.color }));
  const stagingPoolData  = STAGING_POOLS.map(p => ({ name: p.short, value: data.by_pool[p.name] || 0, color: p.color }));
  const topPools = Object.entries(data.by_pool)
    .filter(([name]) => name !== "unknown")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, value]) => ({ name, value }));

  const totalAlerts = data.alerts.quarantined + data.alerts.missing_from_tc + data.alerts.mdm_unenrolled;

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-white tracking-tight">Fleet Overview</h1>
        <p className="text-gray-500 text-sm mt-0.5">CI hardware fleet · real-time</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Monitor} label="Total Workers" value={data.total_workers} color="blue" />
        <StatCard icon={Server} label="Production" value={data.by_state.production || 0} color="green" to="/workers?state=production" />
        <StatCard icon={ShieldOff} label="Quarantined" value={data.alerts.quarantined_non_staging} color="red" to="/workers?tc_quarantined=true" />
        <StatCard icon={Activity} label="Active Alerts" value={totalAlerts} color="red" to="/alerts" />
      </div>

      {/* Sync status */}
      <div className="card p-5 space-y-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          <Clock size={12} /> Sync Status
        </h3>
        {/* Fleet-wide: Taskcluster */}
        {data.sync_status["taskcluster"] && (() => {
          const status = data.sync_status["taskcluster"];
          return (
            <div className="bg-gray-800/40 rounded-lg p-3 border border-gray-700/40 max-w-xs">
              <div className="flex items-center gap-2 mb-2">
                <SyncDot ok={!!status.last_success} />
                <span className="text-xs text-gray-400 font-medium">Taskcluster</span>
              </div>
              <div className="text-sm font-medium text-white">{timeAgo(status.last_success)}</div>
              {status.records_updated !== null && (
                <div className="text-xs text-gray-600 mt-0.5">{status.records_updated.toLocaleString()} records</div>
              )}
            </div>
          );
        })()}
        {/* macOS sources */}
        <div>
          <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">macOS Sources</div>
          <div className="flex gap-3">
            {(["puppet", "simplemdm"] as const).map(source => {
              const status = data.sync_status[source];
              if (!status) return null;
              return (
                <div key={source} className="bg-gray-800/40 rounded-lg p-3 border border-gray-700/40 min-w-[130px]">
                  <div className="flex items-center gap-2 mb-2">
                    <SyncDot ok={!!status.last_success} />
                    <span className="text-xs text-gray-400 font-medium capitalize">{source === "simplemdm" ? "SimpleMDM" : source}</span>
                  </div>
                  <div className="text-sm font-medium text-white">{timeAgo(status.last_success)}</div>
                  {status.records_updated !== null && (
                    <div className="text-xs text-gray-600 mt-0.5">{status.records_updated.toLocaleString()} records</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">Production Workers</h3>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={priorityPoolData} cx="50%" cy="50%" innerRadius={52} outerRadius={80} dataKey="value" paddingAngle={3} strokeWidth={0}>
                {priorityPoolData.map(entry => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "#e5e7eb" }} formatter={(value, name) => {
                const pool = PRIORITY_POOLS.find(p => p.short === name);
                return [value, pool ? `${pool.os} · ${pool.arch}` : name];
              }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-col gap-2 mt-3">
            {priorityPoolData.map((entry, i) => {
              const meta = PRIORITY_POOLS[i];
              return (
                <div key={entry.name} className="flex items-start gap-2">
                  <span className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5" style={{ backgroundColor: entry.color }} />
                  <div>
                    <span className="text-xs text-gray-300 font-mono">{entry.name}</span>
                    <span className="text-[10px] text-gray-500 block">{meta.os} · {meta.arch}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">Staging Workers</h3>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={stagingPoolData} cx="50%" cy="50%" innerRadius={52} outerRadius={80} dataKey="value" paddingAngle={3} strokeWidth={0}>
                {stagingPoolData.map(entry => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "#e5e7eb" }} formatter={(value, name) => {
                const pool = STAGING_POOLS.find(p => p.short === name);
                return [value, pool ? `${pool.os} · ${pool.arch}` : name];
              }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-col gap-2 mt-3">
            {stagingPoolData.map((entry, i) => {
              const meta = STAGING_POOLS[i];
              return (
                <div key={entry.name} className="flex items-start gap-2">
                  <span className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5" style={{ backgroundColor: entry.color }} />
                  <div>
                    <span className="text-xs text-gray-300 font-mono">{entry.name}</span>
                    <span className="text-[10px] text-gray-500 block">{meta.os} · {meta.arch}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">Top Pools</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={topPools} layout="vertical" margin={{ left: 4, right: 16, top: 0, bottom: 0 }}>
              <XAxis type="number" tick={{ fontSize: 10, fill: "#6b7280" }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={160} interval={0} tick={{ fontSize: 10, fill: "#9ca3af", fontFamily: "JetBrains Mono, monospace" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "#e5e7eb" }} cursor={{ fill: "#ffffff08" }} />
              <Bar dataKey="value" fill="#4c6ef5" radius={[0, 4, 4, 0]} maxBarSize={12} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Failure Insights */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Failure Insights · last 7 days
          </h2>
          <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-0.5">
            {FAILURE_PLATFORMS.map(({ key, label }) => (
              <button key={key} onClick={() => setFailurePlatform(key)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  failurePlatform === key
                    ? "bg-gray-700 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="card p-5">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Cpu size={12} /> Top Machine Failures
            </h3>
            {!failures ? (
              <div className="text-xs text-gray-600 py-4 text-center">Loading…</div>
            ) : failures.machine_failures.length === 0 ? (
              <div className="text-xs text-gray-600 py-6 text-center">No failures recorded in the last 7 days</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800/60">
                    <th className="text-left text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold w-5">#</th>
                    <th className="text-left text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold pl-2">Machine</th>
                    <th className="text-left text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold">Pool</th>
                    <th className="text-right text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold">Count</th>
                    <th className="text-right text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold pl-4">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {failures.machine_failures.map((f, i) => (
                    <tr key={f.hostname} className="border-b border-gray-800/30 last:border-0">
                      <td className="py-2 text-[10px] text-gray-700 tabular-nums">{i + 1}</td>
                      <td className="py-2 pl-2">
                        <Link to={`/workers/${f.short_hostname}`} className="text-xs font-mono text-gray-300 hover:text-white transition-colors">
                          {f.short_hostname}
                        </Link>
                      </td>
                      <td className="py-2">
                        <span className="text-[10px] font-mono text-gray-600">{shortPool(f.worker_pool)}</span>
                      </td>
                      <td className="py-2 text-right">
                        <span className="text-xs font-bold text-red-400 tabular-nums">{f.count}</span>
                      </td>
                      <td className="py-2 pl-4 text-right">
                        <span className="text-[10px] text-gray-600 whitespace-nowrap">{timeAgo(f.last_at)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card p-5">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <FlaskConical size={12} /> Top Test Failures
            </h3>
            {!failures ? (
              <div className="text-xs text-gray-600 py-4 text-center">Loading…</div>
            ) : failures.test_failures.length === 0 ? (
              <div className="text-xs text-gray-600 py-6 text-center">
                No test failures recorded
                <div className="text-[10px] text-gray-700 mt-1">Populates as failed tasks are observed during sync</div>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800/60">
                    <th className="text-left text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold w-5">#</th>
                    <th className="text-left text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold pl-2">Task</th>
                    <th className="text-right text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold">Count</th>
                    <th className="text-right text-[10px] text-gray-600 uppercase tracking-wider pb-2 font-semibold pl-4">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {failures.test_failures.map((f, i) => (
                    <tr key={f.task_name} className="border-b border-gray-800/30 last:border-0">
                      <td className="py-2 text-[10px] text-gray-700 tabular-nums">{i + 1}</td>
                      <td className="py-2 pl-2 max-w-[240px]">
                        <span className="text-xs font-mono text-gray-300 break-all">{shortTaskName(f.task_name)}</span>
                      </td>
                      <td className="py-2 text-right">
                        <span className="text-xs font-bold text-orange-400 tabular-nums">{f.count}</span>
                      </td>
                      <td className="py-2 pl-4 text-right">
                        <span className="text-[10px] text-gray-600 whitespace-nowrap">{timeAgo(f.last_at)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
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
            <div>
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">By Branch</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.branch_overrides.by_branch).sort((a, b) => b[1] - a[1]).map(([branch, count]) => (
                  <div key={branch} className="flex items-center gap-2 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-1.5">
                    <GitBranch size={10} className="text-amber-500" />
                    <span className="text-xs font-mono text-amber-300">{branch}</span>
                    <span className="text-xs font-bold text-white tabular-nums">{count}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">By Pool</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.branch_overrides.by_pool).sort((a, b) => b[1] - a[1]).map(([pool, count]) => (
                  <div key={pool} className="flex items-center gap-2 bg-gray-800/40 border border-gray-700/40 rounded-lg px-3 py-1.5">
                    <span className="text-xs font-mono text-gray-400">{pool}</span>
                    <span className="text-xs font-bold text-amber-400 tabular-nums">{count}</span>
                  </div>
                ))}
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
    </div>
  );
}
