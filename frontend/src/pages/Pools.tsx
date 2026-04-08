import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pin, AlertTriangle, GitBranch, Users } from "lucide-react";
import { api } from "../api";
import type { PoolHealth } from "../api";

// The three busiest pools, pinned at top in order
const PINNED_POOLS = [
  "gecko-t-osx-1400-r8",
  "gecko-t-osx-1015-r8",
  "gecko-t-osx-1500-m4",
];

const GEN_COLOR: Record<string, string> = {
  r8: "text-indigo-400",
  m2: "text-cyan-400",
  m4: "text-emerald-400",
};

function healthColor(score: number): string {
  if (score >= 0.9) return "text-emerald-400";
  if (score >= 0.7) return "text-yellow-400";
  if (score >= 0.5) return "text-orange-400";
  return "text-red-400";
}

function healthBarColor(score: number): string {
  if (score >= 0.9) return "bg-emerald-500";
  if (score >= 0.7) return "bg-yellow-500";
  if (score >= 0.5) return "bg-orange-500";
  return "bg-red-500";
}

/** Horizontal stacked activity bar showing staleness buckets */
function ActivityBar({ pool, height = "h-2" }: { pool: PoolHealth; height?: string }) {
  const total = pool.total || 1;
  const segments = [
    { value: pool.active_24h,    color: "bg-emerald-500", label: "active <24h" },
    { value: pool.stale_1_7d,    color: "bg-yellow-500",  label: "1–7d" },
    { value: pool.stale_7_30d,   color: "bg-orange-500",  label: "7–30d" },
    { value: pool.stale_30d_plus + pool.never_seen, color: "bg-red-700", label: ">30d / never" },
  ];
  return (
    <div className={`flex w-full rounded-full overflow-hidden gap-px ${height}`} title={segments.map(s => `${s.label}: ${s.value}`).join(" · ")}>
      {segments.map((s, i) =>
        s.value > 0 ? (
          <div
            key={i}
            className={s.color}
            style={{ width: `${(s.value / total) * 100}%`, minWidth: s.value > 0 ? 2 : 0 }}
          />
        ) : null
      )}
    </div>
  );
}

/** Health score ring for pinned cards */
function HealthRing({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const r = 28;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const color = score >= 0.9 ? "#10b981" : score >= 0.7 ? "#eab308" : score >= 0.5 ? "#f97316" : "#ef4444";
  return (
    <div className="relative w-16 h-16 flex-shrink-0">
      <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#1f2937" strokeWidth="5" />
        <circle
          cx="32" cy="32" r={r}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

function PinnedCard({ pool }: { pool: PoolHealth }) {
  const navigate = useNavigate();
  const shortName = pool.name;
  const issues = pool.quarantined + pool.mdm_unenrolled;
  return (
    <div
      className="card p-5 flex flex-col gap-4 cursor-pointer hover:border-gray-700 transition-all"
      onClick={() => navigate(`/workers?worker_pool=${encodeURIComponent(pool.name)}`)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Pin size={10} className="text-brand-400 flex-shrink-0" />
            <span className="text-[10px] text-brand-400 font-medium uppercase tracking-wider">Priority Pool</span>
          </div>
          <div className="text-sm font-mono font-semibold text-white truncate">{shortName}</div>
          <div className={`text-xs font-mono mt-0.5 ${GEN_COLOR[pool.generation || ""] || "text-gray-500"}`}>
            {pool.generation || "unknown"}
          </div>
        </div>
        <HealthRing score={pool.health_score} />
      </div>

      <ActivityBar pool={pool} height="h-2.5" />

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-lg font-bold text-white tabular-nums">{pool.production}</div>
          <div className="text-[10px] text-gray-600 uppercase tracking-wider">Prod</div>
        </div>
        <div>
          <div className={`text-lg font-bold tabular-nums ${pool.active_24h === pool.production ? "text-emerald-400" : "text-yellow-400"}`}>
            {pool.active_24h}
          </div>
          <div className="text-[10px] text-gray-600 uppercase tracking-wider">Active</div>
        </div>
        <div>
          <div className={`text-lg font-bold tabular-nums ${issues > 0 ? "text-red-400" : "text-gray-600"}`}>
            {issues}
          </div>
          <div className="text-[10px] text-gray-600 uppercase tracking-wider">Issues</div>
        </div>
      </div>

      {(pool.quarantined > 0 || pool.mdm_unenrolled > 0 || pool.branch_override_count > 0) && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-gray-800/60">
          {pool.quarantined > 0 && (
            <span className="text-[10px] bg-red-950/60 text-red-400 border border-red-900/50 px-1.5 py-0.5 rounded-full">
              {pool.quarantined} quarantined
            </span>
          )}
          {pool.mdm_unenrolled > 0 && (
            <span className="text-[10px] bg-yellow-950/60 text-yellow-400 border border-yellow-900/50 px-1.5 py-0.5 rounded-full">
              {pool.mdm_unenrolled} unenrolled
            </span>
          )}
          {pool.branch_override_count > 0 && (
            <span className="text-[10px] bg-amber-950/60 text-amber-400 border border-amber-900/50 px-1.5 py-0.5 rounded-full flex items-center gap-1">
              <GitBranch size={8} /> {pool.branch_override_count} branch override{pool.branch_override_count !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function Pools() {
  const navigate = useNavigate();
  const [pools, setPools] = useState<PoolHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api.fleet.pools()
      .then(d => setPools(d.pools))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <div className="p-8 text-red-400 text-sm">{error}</div>;
  if (loading) return (
    <div className="p-8 flex items-center gap-2 text-gray-600 text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" /> Loading pool data…
    </div>
  );

  const pinnedData = PINNED_POOLS.map(name => pools.find(p => p.name === name)).filter(Boolean) as PoolHealth[];

  const totalWorkers = pools.reduce((s, p) => s + p.total, 0);
  const totalIssues = pools.reduce((s, p) => s + p.quarantined + p.mdm_unenrolled, 0);
  const totalBranch = pools.reduce((s, p) => s + p.branch_override_count, 0);

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Pool Health</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {pools.length} pools · {totalWorkers.toLocaleString()} workers
          </p>
        </div>
        <div className="flex items-center gap-3">
          {totalIssues > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-red-400 bg-red-950/40 border border-red-900/50 px-3 py-1.5 rounded-lg">
              <AlertTriangle size={12} /> {totalIssues} issue{totalIssues !== 1 ? "s" : ""} across fleet
            </div>
          )}
          {totalBranch > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-950/40 border border-amber-900/50 px-3 py-1.5 rounded-lg">
              <GitBranch size={12} /> {totalBranch} branch override{totalBranch !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>

      {/* Pinned priority pools */}
      {pinnedData.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Pin size={11} className="text-brand-400" />
            <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider">Priority Pools</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {pinnedData.map(pool => <PinnedCard key={pool.name} pool={pool} />)}
          </div>
        </div>
      )}

      {/* All pools table */}
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Users size={12} /> All Pools
        </h2>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800/80">
                {["Pool", "Gen", "Health", "Activity", "Total", "Prod", "Active", "Stale", "Issues", "Branch"].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-gray-600 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pools.map(pool => {
                const isPinned = PINNED_POOLS.includes(pool.name);
                const shortName = pool.name;
                const issues = pool.quarantined + pool.mdm_unenrolled;
                const stale = pool.stale_1_7d + pool.stale_7_30d + pool.stale_30d_plus + pool.never_seen;
                return (
                  <tr
                    key={pool.name}
                    className={`border-b border-gray-800/40 hover:bg-gray-800/20 cursor-pointer transition-colors ${isPinned ? "bg-brand-900/10" : ""}`}
                    onClick={() => navigate(`/workers?worker_pool=${encodeURIComponent(pool.name)}`)}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {isPinned && <Pin size={9} className="text-brand-500 flex-shrink-0" />}
                        <span className="text-xs font-mono text-gray-300">{shortName}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-mono font-medium ${GEN_COLOR[pool.generation || ""] || "text-gray-600"}`}>
                        {pool.generation || "?"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${healthBarColor(pool.health_score)}`}
                            style={{ width: `${pool.health_score * 100}%` }}
                          />
                        </div>
                        <span className={`text-xs font-mono tabular-nums ${healthColor(pool.health_score)}`}>
                          {Math.round(pool.health_score * 100)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 min-w-[100px]">
                      <ActivityBar pool={pool} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{pool.total}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{pool.production}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs tabular-nums ${pool.active_24h >= pool.production * 0.9 ? "text-emerald-400" : "text-yellow-400"}`}>
                        {pool.active_24h}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs tabular-nums ${stale > 0 ? "text-orange-400" : "text-gray-600"}`}>
                        {stale || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {issues > 0 ? (
                        <span className="flex items-center gap-1 text-xs text-red-400 tabular-nums">
                          <AlertTriangle size={10} /> {issues}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-700">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {pool.branch_override_count > 0 ? (
                        <span className="flex items-center gap-1 text-xs text-amber-400 tabular-nums">
                          <GitBranch size={10} /> {pool.branch_override_count}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-700">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Activity legend */}
          <div className="px-4 py-3 border-t border-gray-800/60 flex items-center gap-5">
            <span className="text-[10px] text-gray-600 uppercase tracking-wider">Activity bar:</span>
            {[
              { color: "bg-emerald-500", label: "active <24h" },
              { color: "bg-yellow-500",  label: "1–7d" },
              { color: "bg-orange-500",  label: "7–30d" },
              { color: "bg-red-700",     label: ">30d / never seen" },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-sm ${s.color}`} />
                <span className="text-[10px] text-gray-500">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
