import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pin, AlertTriangle, GitBranch, Users, Lock, Hammer, FlaskConical, ChevronDown, Settings2, X, CheckCircle2, Cloud, Terminal, Smartphone } from "lucide-react";
import { api } from "../api";
import type { PoolHealth, PoolOpResult, PoolSources, CloudPool } from "../api";

const PINNED_POOLS = [
  "gecko-t-osx-1400-r8",
  "gecko-t-osx-1015-r8",
  "gecko-t-osx-1500-m4",
];

const GEN_COLOR: Record<string, string> = {
  r8:   "text-indigo-400",
  m2:   "text-cyan-400",
  m4:   "text-emerald-400",
  "2404": "text-teal-400",
  "1804": "text-teal-600",
};

const PROJECT_COLORS: Record<string, string> = {
  try:               "bg-sky-500",
  autoland:          "bg-violet-500",
  "mozilla-central": "bg-emerald-500",
  "mozilla-beta":    "bg-amber-500",
  "mozilla-release": "bg-orange-500",
  github:            "bg-pink-500",
  other:             "bg-gray-500",
  unknown:           "bg-gray-700",
};

const PROJECT_TEXT: Record<string, string> = {
  try:               "text-sky-400",
  autoland:          "text-violet-400",
  "mozilla-central": "text-emerald-400",
  "mozilla-beta":    "text-amber-400",
  "mozilla-release": "text-orange-400",
  github:            "text-pink-400",
  other:             "text-gray-400",
  unknown:           "text-gray-600",
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
          <div key={i} className={s.color} style={{ width: `${(s.value / total) * 100}%`, minWidth: 2 }} />
        ) : null
      )}
    </div>
  );
}

function SourceBar({ sources }: { sources: PoolSources | null | undefined }) {
  if (!sources) return <div className="h-2 w-full bg-gray-800 rounded-full animate-pulse" />;
  if (sources.sample_size === 0) return <div className="text-[10px] text-gray-700">No running tasks</div>;

  const total = sources.sample_size;
  const entries = Object.entries(sources.by_project);
  return (
    <div className="space-y-2">
      <div className="flex w-full h-2 rounded-full overflow-hidden gap-px">
        {entries.map(([proj, count]) => (
          <div key={proj} className={PROJECT_COLORS[proj] ?? "bg-gray-500"} style={{ width: `${(count / total) * 100}%` }} title={`${proj}: ${count}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map(([proj, count]) => (
          <div key={proj} className="flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PROJECT_COLORS[proj] ?? "bg-gray-500"}`} />
            <span className={`text-[10px] font-medium ${PROJECT_TEXT[proj] ?? "text-gray-400"}`}>{proj}</span>
            <span className="text-[10px] text-gray-600 tabular-nums">{Math.round((count / total) * 100)}%</span>
          </div>
        ))}
        <span className="text-[10px] text-gray-700 ml-auto">n={total}</span>
      </div>
    </div>
  );
}

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
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="5"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold" style={{ color }}>{pct}%</span>
    </div>
  );
}

function PoolBranchModal({ pool, onClose }: { pool: PoolHealth; onClose: () => void }) {
  const [branch, setBranch] = useState("");
  const [repo, setRepo] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<PoolOpResult | null>(null);
  const [error, setError] = useState("");
  const [op, setOp] = useState<"set" | "clear" | null>(null);

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (!branch.trim()) return;
    setOp("set"); setStatus("loading"); setResult(null); setError("");
    try {
      setResult(await api.pools.setBranch(pool.name, branch.trim(), repo.trim() || undefined, email.trim() || undefined));
      setStatus("done");
    } catch (err: unknown) { setError(String(err instanceof Error ? err.message : err)); setStatus("error"); }
  }

  async function handleClear() {
    setOp("clear"); setStatus("loading"); setResult(null); setError("");
    try {
      setResult(await api.pools.clearBranch(pool.name));
      setStatus("done");
    } catch (err: unknown) { setError(String(err instanceof Error ? err.message : err)); setStatus("error"); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-gray-900 border border-gray-700/80 rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <div className="text-sm font-semibold text-white">Branch Override</div>
            <div className="text-[11px] text-gray-500 font-mono mt-0.5">{pool.name}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-600 hover:text-gray-400 transition-colors"><X size={14} /></button>
        </div>
        <div className="p-5 space-y-5">
          <form onSubmit={handleSet} className="space-y-3">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Set Branch on All Workers</div>
            <div className="space-y-2">
              <input className="w-full bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40 font-mono"
                placeholder="branch name (required)" value={branch} onChange={e => setBranch(e.target.value)} />
              <input className="w-full bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40 font-mono"
                placeholder="repo URL (default: github.com/mozilla-platform-ops/ronin_puppet)" value={repo} onChange={e => setRepo(e.target.value)} />
              <input className="w-full bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
                placeholder="email (default: relops@mozilla.com)" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <button type="submit" disabled={!branch.trim() || status === "loading"}
              className="flex items-center gap-1.5 text-xs bg-brand-900/40 hover:bg-brand-900/60 border border-brand-800/50 text-brand-400 hover:text-brand-300 px-3 py-1.5 rounded-lg transition-all disabled:opacity-40">
              <GitBranch size={12} />
              {status === "loading" && op === "set" ? `Setting on ${pool.total} workers…` : `Set on all ${pool.total} workers`}
            </button>
          </form>
          <div className="border-t border-gray-800/60" />
          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Clear Overrides</div>
            <p className="text-[11px] text-gray-600">
              Removes <span className="font-mono">/opt/puppet_environments/ronin_settings</span> from all workers.
              {pool.branch_override_count > 0 && ` ${pool.branch_override_count} worker${pool.branch_override_count !== 1 ? "s" : ""} currently have overrides.`}
            </p>
            <button onClick={handleClear} disabled={status === "loading"}
              className="flex items-center gap-1.5 text-xs bg-red-950/40 hover:bg-red-950/60 border border-red-900/50 text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg transition-all disabled:opacity-40">
              <X size={12} />
              {status === "loading" && op === "clear" ? "Clearing…" : `Clear on all ${pool.total} workers`}
            </button>
          </div>
          {status === "error" && <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2">{error}</div>}
          {status === "done" && result && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <CheckCircle2 size={13} className="text-emerald-400" />
                <span className="text-emerald-400 font-medium">{result.succeeded}/{result.total} succeeded</span>
                {result.failed.length > 0 && <span className="text-red-400 ml-1">{result.failed.length} failed</span>}
              </div>
              {result.failed.length > 0 && (
                <div className="bg-red-950/30 border border-red-900/40 rounded-lg p-3 space-y-1 max-h-40 overflow-y-auto">
                  {result.failed.map(f => (
                    <div key={f.hostname} className="text-[10px] font-mono">
                      <span className="text-red-400">{f.hostname}</span>
                      {f.error && <span className="text-gray-600"> — {f.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PinnedCard({ pool, pending, sources, onManage }: {
  pool: PoolHealth;
  pending: number | null;
  sources: PoolSources | null | undefined;
  onManage: (p: PoolHealth) => void;
}) {
  const navigate = useNavigate();
  const staleAll = pool.stale_1_7d + pool.stale_7_30d + pool.stale_30d_plus + pool.never_seen;
  const unavailable = pool.quarantined + staleAll + pool.branch_override_count;
  const available = Math.max(pool.total - pool.quarantined - staleAll, 1);
  const utilPct = Math.round(((pool.running_tasks ?? 0) / available) * 100);

  return (
    <div className="card p-5 flex flex-col gap-4 cursor-pointer hover:border-gray-700 transition-all"
      onClick={() => navigate(`/workers?worker_pool=${encodeURIComponent(pool.name)}`)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-mono font-semibold text-white truncate">{pool.name}</div>
          <div className={`text-xs font-mono mt-0.5 ${GEN_COLOR[pool.generation || ""] || "text-gray-500"}`}>
            {pool.generation || "unknown"}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <button onClick={e => { e.stopPropagation(); onManage(pool); }}
            className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-600 hover:text-gray-300 transition-colors mt-0.5" title="Manage branch overrides">
            <Settings2 size={13} />
          </button>
          <HealthRing score={pool.health_score} />
        </div>
      </div>

      {/* Queue depth + utilization */}
      <div className="grid grid-cols-2 gap-3 bg-gray-800/30 rounded-lg p-3 border border-gray-700/30">
        <div>
          <div className={`text-2xl font-bold tabular-nums ${pending != null && pending > 500 ? "text-orange-300" : "text-white"}`}>
            {pending === null || pending === undefined ? "—" : pending.toLocaleString()}
          </div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">pending tasks</div>
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums text-white">
            {pool.running_tasks ?? 0}
            <span className="text-sm font-normal text-gray-500"> / {pool.active_24h}</span>
          </div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">workers running</div>
          <div className="mt-1.5 w-full bg-gray-700/60 rounded-full h-1 overflow-hidden">
            <div className={`h-1 rounded-full transition-all ${utilPct >= 90 ? "bg-orange-400" : utilPct >= 70 ? "bg-yellow-400" : "bg-emerald-400"}`}
              style={{ width: `${Math.min(utilPct, 100)}%` }} />
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">{utilPct}% utilized</div>
        </div>
      </div>

      <ActivityBar pool={pool} height="h-2" />

      <div>
        <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Job Sources</div>
        <SourceBar sources={sources} />
      </div>

      {sources && Object.keys(sources.by_user).length > 0 && (
        <div>
          <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Top Submitters</div>
          <div className="space-y-1">
            {Object.entries(sources.by_user).slice(0, 4).map(([user, count], i) => {
              const short = user.replace(/@.*$/, "");
              const pct = Math.round((count / sources.sample_size) * 100);
              return (
                <div key={user} className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-700 tabular-nums w-3">{i + 1}</span>
                  <span className="text-[10px] font-mono text-gray-400 truncate flex-1" title={user}>{short}</span>
                  <span className="text-[10px] text-gray-600 tabular-nums">{pct}%</span>
                  <span className="text-[10px] text-gray-700 tabular-nums">({count})</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {unavailable > 0 ? (
        <div className="pt-1 border-t border-gray-800/60">
          <div className="text-[10px] text-gray-600 mb-1.5">{unavailable} worker{unavailable !== 1 ? "s" : ""} unavailable</div>
          <div className="flex flex-wrap gap-1">
            {pool.quarantined > 0 && (
              <span className="text-[10px] bg-red-950/60 text-red-400 border border-red-900/50 px-1.5 py-0.5 rounded-full">{pool.quarantined} quarantined</span>
            )}
            {staleAll > 0 && (
              <span className="text-[10px] bg-orange-950/60 text-orange-400 border border-orange-900/50 px-1.5 py-0.5 rounded-full">{staleAll} stale</span>
            )}
            {pool.branch_override_count > 0 && (
              <span className="text-[10px] bg-amber-950/60 text-amber-400 border border-amber-900/50 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                <GitBranch size={8} /> {pool.branch_override_count} branched
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="pt-1 border-t border-gray-800/60">
          <span className="text-[10px] text-emerald-600">All workers available</span>
        </div>
      )}
    </div>
  );
}

function PoolTable({ pools, pinnedPools, navigate, showLegend, onManage, pending }: {
  pools: PoolHealth[];
  pinnedPools: string[];
  navigate: (path: string) => void;
  showLegend: boolean;
  onManage: (pool: PoolHealth) => void;
  pending: Record<string, number | null>;
}) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800/80">
            {["Pool", "Gen", "Health", "Activity", "Pending", "Total", "Prod", "Running", "Active", "Stale", "Issues", "Branch", ""].map(h => (
              <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-gray-600 uppercase tracking-wider whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pools.map(pool => {
            const isPinned = pinnedPools.includes(pool.name);
            const issues = pool.quarantined + pool.mdm_unenrolled;
            const stale = pool.stale_1_7d + pool.stale_7_30d + pool.stale_30d_plus + pool.never_seen;
            const p = pending[pool.name];
            return (
              <tr key={pool.name}
                className={`border-b border-gray-800/40 hover:bg-gray-800/20 cursor-pointer transition-colors ${isPinned ? "bg-brand-900/10" : ""}`}
                onClick={() => navigate(`/workers?worker_pool=${encodeURIComponent(pool.name)}`)}>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    {isPinned && <Pin size={9} className="text-brand-500 flex-shrink-0" />}
                    <span className="text-xs font-mono text-gray-300">{pool.name}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs font-mono font-medium ${GEN_COLOR[pool.generation || ""] || "text-gray-600"}`}>{pool.generation || "?"}</span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${healthBarColor(pool.health_score)}`} style={{ width: `${pool.health_score * 100}%` }} />
                    </div>
                    <span className={`text-xs font-mono tabular-nums ${healthColor(pool.health_score)}`}>{Math.round(pool.health_score * 100)}%</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 min-w-[100px]"><ActivityBar pool={pool} /></td>
                <td className="px-4 py-2.5">
                  {p != null ? (
                    <span className={`text-xs font-mono tabular-nums font-medium ${p > 500 ? "text-orange-300" : p > 0 ? "text-yellow-400" : "text-gray-600"}`}>
                      {p.toLocaleString()}
                    </span>
                  ) : <span className="text-xs text-gray-700">—</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{pool.total}</td>
                <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{pool.production}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs tabular-nums font-medium ${(pool.running_tasks ?? 0) >= pool.active_24h * 0.85 ? "text-orange-400" : "text-gray-400"}`}>
                    {pool.running_tasks ?? 0}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs tabular-nums ${pool.active_24h >= pool.production * 0.9 ? "text-emerald-400" : "text-yellow-400"}`}>{pool.active_24h}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs tabular-nums ${stale > 0 ? "text-orange-400" : "text-gray-600"}`}>{stale || "—"}</span>
                </td>
                <td className="px-4 py-2.5">
                  {issues > 0 ? (
                    <span className="flex items-center gap-1 text-xs text-red-400 tabular-nums"><AlertTriangle size={10} /> {issues}</span>
                  ) : <span className="text-xs text-gray-700">—</span>}
                </td>
                <td className="px-4 py-2.5">
                  {pool.branch_override_count > 0 ? (
                    <span className="flex items-center gap-1 text-xs text-amber-400 tabular-nums"><GitBranch size={10} /> {pool.branch_override_count}</span>
                  ) : <span className="text-xs text-gray-700">—</span>}
                </td>
                <td className="px-4 py-2.5">
                  <button onClick={e => { e.stopPropagation(); onManage(pool); }}
                    className="p-1 rounded hover:bg-gray-700 text-gray-700 hover:text-gray-300 transition-colors" title="Manage branch overrides">
                    <Settings2 size={12} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {showLegend && (
        <div className="px-4 py-3 border-t border-gray-800/60 flex items-center gap-5">
          <span className="text-[10px] text-gray-600 uppercase tracking-wider">Activity bar:</span>
          {[
            { color: "bg-emerald-500", label: "active <24h" },
            { color: "bg-yellow-500",  label: "1–7d" },
            { color: "bg-orange-500",  label: "7–30d" },
            { color: "bg-red-700",     label: ">30d / never" },
          ].map(s => (
            <div key={s.label} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-sm ${s.color}`} />
              <span className="text-[10px] text-gray-500">{s.label}</span>
            </div>
          ))}
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
  const [showOther, setShowOther] = useState(false);
  const [managingPool, setManagingPool] = useState<PoolHealth | null>(null);
  const [pending, setPending] = useState<Record<string, number | null>>({});
  const [sources, setSources] = useState<Record<string, PoolSources>>({});
  const [cloudPoolData, setCloudPoolData] = useState<CloudPool[]>([]);
  const [androidPoolData, setAndroidPoolData] = useState<CloudPool[]>([]);
  const toggleOther = useCallback(() => setShowOther(v => !v), []);

  useEffect(() => {
    api.fleet.pools()
      .then(d => setPools(d.pools))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));

    api.fleet.pendingCounts()
      .then(d => setPending(d.pending_counts))
      .catch(() => {});

    for (const poolName of PINNED_POOLS) {
      api.fleet.poolSources(poolName)
        .then(s => setSources(prev => ({ ...prev, [poolName]: s })))
        .catch(() => {});
    }
    api.fleet.cloudPools()
      .then(d => setCloudPoolData(d.pools))
      .catch(() => {});
    api.fleet.androidPools()
      .then(d => setAndroidPoolData(d.pools))
      .catch(() => {});
  }, []);

  if (error) return <div className="p-8 text-red-400 text-sm">{error}</div>;
  if (loading) return (
    <div className="p-8 flex items-center gap-2 text-gray-600 text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" /> Loading pool data…
    </div>
  );

  const pinnedData = PINNED_POOLS.map(name => pools.find(p => p.name === name)).filter(Boolean) as PoolHealth[];

  const linuxHwPools = pools.filter(p => p.name.includes("linux"));
  const signingPools = pools.filter(p => !p.name.includes("linux") && p.name.includes("signing"));
  const builderPools = pools.filter(p => !p.name.includes("linux") && !p.name.includes("signing") && p.name.includes("-b-"));
  const testerPools  = pools.filter(p => !p.name.includes("linux") && !p.name.includes("signing") && !p.name.includes("-b-") && p.name.includes("-t-"));
  const otherPools   = pools.filter(p => !p.name.includes("linux") && !p.name.includes("signing") && !p.name.includes("-b-") && !p.name.includes("-t-"));

  const totalWorkers = pools.reduce((s, p) => s + p.total, 0);
  const totalIssues  = testerPools.reduce((s, p) => s + p.quarantined + p.mdm_unenrolled, 0);
  const totalBranch  = testerPools.reduce((s, p) => s + p.branch_override_count, 0);

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Pool Health</h1>
          <p className="text-gray-500 text-sm mt-0.5">{pools.length} pools · {totalWorkers.toLocaleString()} workers</p>
        </div>
        <div className="flex items-center gap-3">
          {totalIssues > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-red-400 bg-red-950/40 border border-red-900/50 px-3 py-1.5 rounded-lg">
              <AlertTriangle size={12} /> {totalIssues} issue{totalIssues !== 1 ? "s" : ""}
            </div>
          )}
          {totalBranch > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-950/40 border border-amber-900/50 px-3 py-1.5 rounded-lg">
              <GitBranch size={12} /> {totalBranch} branch override{totalBranch !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>

      {pinnedData.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Pin size={11} className="text-brand-400" />
            <span className="text-xs font-semibold text-brand-400 uppercase tracking-wider">Priority Pools</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {pinnedData.map(pool => (
              <PinnedCard key={pool.name} pool={pool} pending={pending[pool.name] ?? null}
                sources={sources[pool.name]} onManage={setManagingPool} />
            ))}
          </div>
        </div>
      )}

      {testerPools.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <FlaskConical size={12} /> Tester Pools
          </h2>
          <PoolTable pools={testerPools} pinnedPools={PINNED_POOLS} navigate={navigate} showLegend onManage={setManagingPool} pending={pending} />
        </div>
      )}

      {builderPools.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
            <Hammer size={12} /> Builder Pools
          </h2>
          <p className="text-[11px] text-gray-600 mb-3">Build workers — identified by <span className="font-mono">-b-</span> in pool name.</p>
          <PoolTable pools={builderPools} pinnedPools={[]} navigate={navigate} showLegend={false} onManage={setManagingPool} pending={pending} />
        </div>
      )}

      {signingPools.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
            <Lock size={12} /> Signing Pools
          </h2>
          <p className="text-[11px] text-gray-600 mb-3">
            Signing workers operate differently — activity and health metrics may not reflect actual pool status.
          </p>
          <PoolTable pools={signingPools} pinnedPools={[]} navigate={navigate} showLegend={false} onManage={setManagingPool} pending={pending} />
        </div>
      )}

      {linuxHwPools.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
            <Terminal size={12} /> Linux Hardware Pools
          </h2>
          <p className="text-[11px] text-gray-600 mb-3">Physical Linux hardware in MDC1 — branch overrides via <span className="font-mono">/etc/puppet/ronin_settings</span>.</p>
          <PoolTable pools={linuxHwPools} pinnedPools={[]} navigate={navigate} showLegend onManage={setManagingPool} pending={pending} />
        </div>
      )}

      {cloudPoolData.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
            <Cloud size={12} /> Cloud Linux Pools
          </h2>
          <p className="text-[11px] text-gray-600 mb-3">Ephemeral cloud workers — auto-scale to demand. Read-only load view.</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {cloudPoolData.map(p => {
              const load = p.total > 0 ? Math.round((p.running / p.total) * 100) : 0;
              const loadColor = load >= 90 ? "bg-orange-400" : load >= 60 ? "bg-yellow-400" : "bg-teal-400";
              return (
                <div key={p.name} className="card p-4 flex flex-col gap-3">
                  <div className="font-mono text-xs text-white truncate">{p.name}</div>
                  <div className="grid grid-cols-2 gap-2 bg-gray-800/30 rounded-lg p-2.5 border border-gray-700/30">
                    <div>
                      <div className={`text-xl font-bold tabular-nums ${p.pending > 200 ? "text-orange-300" : "text-white"}`}>
                        {p.pending.toLocaleString()}
                      </div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">pending</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold tabular-nums text-white">
                        {p.running}
                        <span className="text-xs font-normal text-gray-500"> / {p.total}</span>
                      </div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">running</div>
                    </div>
                  </div>
                  <div>
                    <div className="w-full bg-gray-700/60 rounded-full h-1.5 overflow-hidden">
                      <div className={`h-1.5 rounded-full transition-all ${loadColor}`} style={{ width: `${Math.min(load, 100)}%` }} />
                    </div>
                    <div className="text-[10px] text-gray-600 mt-1">{load}% capacity utilized</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {androidPoolData.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
            <Smartphone size={12} /> Android Hardware Pools
          </h2>
          <p className="text-[11px] text-gray-600 mb-3">Physical Android devices via Bitbar and Lambda — read-only load view.</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {androidPoolData.map(p => {
              const load = p.total > 0 ? Math.round((p.running / p.total) * 100) : 0;
              const loadColor = load >= 90 ? "bg-orange-400" : load >= 60 ? "bg-yellow-400" : "bg-green-500";
              const isLambda = p.name.includes("lambda");
              const deviceLabel = p.name.includes("a55") ? "Samsung A55"
                : p.name.includes("p6") ? "Pixel 6"
                : p.name.includes("s24") ? "Galaxy S24"
                : p.name.includes("p5") ? "Pixel 5"
                : p.name;
              const infra = isLambda ? "Lambda" : "Bitbar";
              const isAlpha = p.name.includes("alpha");
              return (
                <div key={p.name} className="card p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-white truncate">{p.name}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="text-[10px] text-green-400 font-medium">{deviceLabel}</span>
                        {isAlpha && <span className="text-[10px] bg-purple-900/40 text-purple-400 border border-purple-800/40 px-1 rounded">alpha</span>}
                        <span className="text-[10px] text-gray-600">{infra}</span>
                      </div>
                    </div>
                    <div className="text-[10px] text-gray-600 tabular-nums flex-shrink-0">{p.total} devices</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 bg-gray-800/30 rounded-lg p-2.5 border border-gray-700/30">
                    <div>
                      <div className={`text-xl font-bold tabular-nums ${p.pending > 50 ? "text-orange-300" : "text-white"}`}>
                        {p.pending.toLocaleString()}
                      </div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">pending</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold tabular-nums text-white">
                        {p.running}
                        <span className="text-xs font-normal text-gray-500"> / {p.total}</span>
                      </div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">running</div>
                    </div>
                  </div>
                  <div>
                    <div className="w-full bg-gray-700/60 rounded-full h-1.5 overflow-hidden">
                      <div className={`h-1.5 rounded-full transition-all ${loadColor}`} style={{ width: `${Math.min(load, 100)}%` }} />
                    </div>
                    <div className="text-[10px] text-gray-600 mt-1">{load}% capacity utilized</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {otherPools.length > 0 && (
        <div>
          <button onClick={toggleOther}
            className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-400 transition-colors mb-3">
            <Users size={12} />
            Other
            <span className="text-gray-700 normal-case font-normal tracking-normal">({otherPools.length})</span>
            <ChevronDown size={12} className={`transition-transform ${showOther ? "rotate-180" : ""}`} />
          </button>
          {showOther && <PoolTable pools={otherPools} pinnedPools={[]} navigate={navigate} showLegend={false} onManage={setManagingPool} pending={pending} />}
        </div>
      )}

      {managingPool && <PoolBranchModal pool={managingPool} onClose={() => setManagingPool(null)} />}
    </div>
  );
}
