import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Pin, AlertTriangle, GitBranch, Users, Lock, Hammer, FlaskConical, ChevronDown, Terminal, Smartphone, Monitor, Pencil, Check, X, RotateCcw, GripVertical, ShieldOff, Cpu } from "lucide-react";
import { api } from "../api";
import type { PoolHealth, PoolSources, CloudPool, FleetSummary, RoninPR } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { MacMigrationCard } from "../components/Showcase";

const MAX_PINNED = 4;

// Curated per-section defaults; sections without an entry default to their first few pools.
const SECTION_DEFAULTS: Record<string, string[]> = {
  mac: ["gecko-t-osx-1400-r8", "gecko-t-osx-1015-r8", "gecko-t-osx-1500-m4"],
};

function pinnedStorageKey(section: string): string {
  return `hangar.pinnedPools.${section || "overview"}`;
}

function defaultPinned(section: string, available: string[]): string[] {
  return SECTION_DEFAULTS[section] ?? available.slice(0, 3);
}

// Legacy per-browser store — read-only now, used once to migrate pins into the per-user backend.
function legacyLocalPinned(section: string): string[] {
  try {
    const raw = localStorage.getItem(pinnedStorageKey(section));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(x => typeof x === "string")) {
        return parsed.slice(0, MAX_PINNED);
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// Pools whose generation can't be derived from Taskcluster metadata — pin it here.
const GENERATION_OVERRIDES: Record<string, string> = {
  "gecko-t-osx-1500-m-vms": "m4",
};

function poolGeneration(pool: PoolHealth): string {
  return pool.generation || GENERATION_OVERRIDES[pool.name] || "";
}

const GEN_COLOR: Record<string, string> = {
  r8:    "text-indigo-400",
  m2:    "text-cyan-400",
  m4:    "text-emerald-400",
  "2404": "text-teal-400",
  "1804": "text-teal-600",
  nuc13: "text-sky-400",
  nuc12: "text-slate-400",
  win7:  "text-gray-500",
};

function isLinuxPool(name: string): boolean {
  return name.includes("linux");
}

function isWindowsPool(name: string): boolean {
  return name.includes("win");
}

function cloudPoolId(pool: CloudPool): string {
  return pool.id || `${pool.provisioner}/${pool.name}`;
}

function hardwarePoolId(pool: PoolHealth): string {
  return pool.provisioner ? `${pool.provisioner}/${pool.name}` : pool.name;
}

function provisionerSummary(pools: CloudPool[]): string {
  const provisioners = [...new Set(pools.map(p => p.provisioner))].sort();
  return provisioners.length === 1 ? provisioners[0] : `${provisioners.length} provisioners`;
}

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

function pendingColor(n: number | null | undefined, highThreshold = 500, midThreshold = 100): string {
  if (n == null) return "text-gray-600";
  if (n === 0)              return "text-emerald-400";
  if (n <= midThreshold)    return "text-emerald-400";
  if (n <= highThreshold)   return "text-yellow-400";
  return "text-orange-300";
}

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
  const total = sources?.sample_size ?? 0;
  const entries = sources && total > 0 ? Object.entries(sources.by_project) : [];
  return (
    <div className="space-y-2">
      {entries.length > 0 ? (
        <div className="flex w-full h-2 rounded-full overflow-hidden gap-px">
          {entries.map(([proj, count]) => (
            <div key={proj} className={PROJECT_COLORS[proj] ?? "bg-gray-500"} style={{ width: `${(count / total) * 100}%` }} title={`${proj}: ${count}`} />
          ))}
        </div>
      ) : (
        <div className={`h-2 w-full bg-gray-800 rounded-full ${sources ? "" : "animate-pulse"}`} />
      )}
      {/* Reserve consistent height (~2 legend rows) so cards stay even whether or not a pool has job sources */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 min-h-[2rem] content-start">
        {entries.length > 0 ? (
          <>
            {entries.map(([proj, count]) => (
              <div key={proj} className="flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PROJECT_COLORS[proj] ?? "bg-gray-500"}`} />
                <span className={`text-[10px] font-medium ${PROJECT_TEXT[proj] ?? "text-gray-400"}`}>{proj}</span>
                <span className="text-[10px] text-gray-600 tabular-nums">{Math.round((count / total) * 100)}%</span>
              </div>
            ))}
            <span className="text-[10px] text-gray-700 ml-auto">n={total}</span>
          </>
        ) : (
          <span className="text-[10px] text-gray-700">{sources ? "No running tasks" : ""}</span>
        )}
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

function PinnedCard({ pool, pending, sources }: {
  pool: PoolHealth;
  pending: number | null;
  sources: PoolSources | null | undefined;
}) {
  const navigate = useNavigate();
  const staleAll = pool.stale_1_7d + pool.stale_7_30d + pool.stale_30d_plus + pool.never_seen;
  const unavailable = pool.quarantined + staleAll + pool.branch_override_count;
  const available = Math.max(pool.total - pool.quarantined - staleAll, 1);
  const utilPct = Math.round(((pool.running_tasks ?? 0) / available) * 100);

  return (
    <div className="card p-5 flex flex-col gap-4 cursor-pointer hover:border-gray-700 transition-all"
      onClick={() => navigate(`/workers?worker_pool=${encodeURIComponent(pool.name)}`)}
      title={hardwarePoolId(pool)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-mono font-semibold text-white truncate">{pool.name}</div>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            {pool.provisioner && (
              <span className="max-w-full truncate text-[10px] font-mono text-emerald-300 bg-emerald-950/35 border border-emerald-900/40 rounded px-1.5 py-0.5">
                {pool.provisioner}
              </span>
            )}
            <span className={`text-xs font-mono ${GEN_COLOR[poolGeneration(pool)] || "text-gray-500"}`}>
              {poolGeneration(pool) || "unknown"}
            </span>
          </div>
        </div>
        <HealthRing score={pool.health_score} />
      </div>

      {/* Queue depth + utilization */}
      <div className="grid grid-cols-2 gap-3 bg-gray-800/30 rounded-lg p-3 border border-gray-700/30">
        <div>
          <div className={`text-2xl font-bold tabular-nums ${pendingColor(pending)}`}>
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

      <div>
        <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Top Submitters</div>
        <div className="space-y-1">
          {Array.from({ length: 4 }).map((_, i) => {
            const entry = sources ? Object.entries(sources.by_user)[i] : undefined;
            if (!entry) {
              return (
                <div key={`ph-${i}`} className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-700 tabular-nums w-3">{i + 1}</span>
                  <span className="text-[10px] font-mono text-gray-700 flex-1">—</span>
                </div>
              );
            }
            const [user, count] = entry;
            const short = user.replace(/@.*$/, "");
            const pct = Math.round((count / (sources?.sample_size || 1)) * 100);
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

      {unavailable > 0 ? (
        <div className="pt-1 border-t border-gray-800/60 min-h-[2.75rem]">
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
        <div className="pt-1 border-t border-gray-800/60 min-h-[2.75rem]">
          <span className="text-[10px] text-emerald-600">All workers available</span>
        </div>
      )}
    </div>
  );
}

function PoolTable({ pools, pinnedPools, navigate, showLegend, pending, showProvisioner = false }: {
  pools: PoolHealth[];
  pinnedPools: string[];
  navigate: (path: string) => void;
  showLegend: boolean;
  pending: Record<string, number | null>;
  showProvisioner?: boolean;
}) {
  const headers = ["Pool", "Gen", "Health", "Activity", "Pending", "Total", "Prod", "Running", "Active", "Stale", "Issues", "Branch"];
  if (showProvisioner) headers.splice(1, 0, "Provisioner");

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800/80">
            {headers.map(h => (
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
                {showProvisioner && (
                  <td className="px-4 py-2.5">
                    {pool.provisioner ? (
                      <span className="text-xs font-mono text-emerald-300">{pool.provisioner}</span>
                    ) : <span className="text-xs text-gray-700">—</span>}
                  </td>
                )}
                <td className="px-4 py-2.5">
                  <span className={`text-xs font-mono font-medium ${GEN_COLOR[poolGeneration(pool)] || "text-gray-600"}`}>{poolGeneration(pool) || "?"}</span>
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
                    <span className={`text-xs font-mono tabular-nums font-medium ${pendingColor(p)}`}>
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

function CloudPoolCard({ pool, sources }: { pool: CloudPool; sources?: PoolSources | null }) {
  const load = pool.total > 0 ? Math.round((pool.running / pool.total) * 100) : 0;
  const isAndroid = pool.provisioner === "proj-autophone";
  const isLambda = pool.name.includes("lambda");
  const isAlpha = pool.name.includes("alpha");
  const deviceLabel = pool.name.includes("a55") ? "Samsung A55"
    : pool.name.includes("p6") ? "Pixel 6"
    : pool.name.includes("s24") ? "Galaxy S24"
    : pool.name.includes("p5") ? "Pixel 5"
    : null;
  const infra = isLambda ? "Lambda" : isAndroid ? "Bitbar" : "Linux Cloud";
  const ringColor = load >= 90 ? "#f97316" : load >= 60 ? "#eab308" : "#10b981";
  const r = 28, circ = 2 * Math.PI * r;
  const fullPoolId = cloudPoolId(pool);

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0" title={fullPoolId}>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="max-w-full truncate text-[10px] font-mono text-teal-300 bg-teal-950/40 border border-teal-900/40 rounded px-1.5 py-0.5">
              {pool.provisioner}
            </span>
            <span className="text-[10px] text-gray-600 uppercase tracking-wider">provisioner</span>
          </div>
          <div className="mt-1 text-sm font-mono font-semibold text-white leading-snug break-all">{pool.name}</div>
          <div className="flex items-center gap-1.5 mt-1">
            {deviceLabel
              ? <span className="text-xs text-green-400 font-medium">{deviceLabel}</span>
              : <span className="text-xs text-gray-500 font-mono">{infra}</span>
            }
            {isAlpha && <span className="text-[10px] bg-purple-900/40 text-purple-400 border border-purple-800/40 px-1.5 py-0.5 rounded-full">alpha</span>}
            {deviceLabel && <span className="text-[10px] text-gray-600">{infra}</span>}
          </div>
        </div>
        <div className="relative w-16 h-16 flex-shrink-0">
          <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
            <circle cx="32" cy="32" r={r} fill="none" stroke="#1f2937" strokeWidth="5" />
            <circle cx="32" cy="32" r={r} fill="none" stroke={ringColor} strokeWidth="5"
              strokeDasharray={`${(load / 100) * circ} ${circ}`} strokeLinecap="round" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-sm font-bold" style={{ color: ringColor }}>
            {load}%
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 bg-gray-800/30 rounded-lg p-3 border border-gray-700/30">
        <div>
          <div className={`text-2xl font-bold tabular-nums ${pendingColor(pool.pending, isAndroid ? 50 : 200, isAndroid ? 10 : 50)}`}>
            {pool.pending.toLocaleString()}
          </div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">pending tasks</div>
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums text-white">
            {pool.running}
            <span className="text-sm font-normal text-gray-500"> / {pool.total}</span>
          </div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">{isAndroid ? "devices running" : "workers running"}</div>
          <div className="mt-1.5 w-full bg-gray-700/60 rounded-full h-1 overflow-hidden">
            <div className={`h-1 rounded-full transition-all ${load >= 90 ? "bg-orange-400" : load >= 60 ? "bg-yellow-400" : "bg-emerald-400"}`}
              style={{ width: `${Math.min(load, 100)}%` }} />
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">{load}% utilized</div>
        </div>
      </div>

      {sources !== undefined && (
        <div>
          <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Job Sources</div>
          <SourceBar sources={sources} />
        </div>
      )}

      {sources && (
        <div>
          <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Top Submitters</div>
          <div className="space-y-1">
            {Array.from({ length: 4 }).map((_, i) => {
              const entry = Object.entries(sources.by_user).sort((a, b) => b[1] - a[1])[i];
              if (!entry) {
                return (
                  <div key={`ph-${i}`} className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-700 tabular-nums w-3">{i + 1}</span>
                    <span className="text-[10px] font-mono text-gray-700 flex-1">—</span>
                  </div>
                );
              }
              const [user, count] = entry;
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
    </div>
  );
}


function AndroidPoolCards({ pools, sources }: { pools: CloudPool[]; sources: Record<string, PoolSources> }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {pools.map(p => <CloudPoolCard key={cloudPoolId(p)} pool={p} sources={sources[p.name]} />)}
    </div>
  );
}

function CloudPoolTable({ pools }: { pools: CloudPool[] }) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800/80">
            {["Provisioner", "Worker Type", "Pending", "Running", "Total", "Load"].map(h => (
              <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-gray-600 uppercase tracking-wider whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pools.map(p => {
            const load = p.total > 0 ? Math.round((p.running / p.total) * 100) : 0;
            return (
              <tr key={cloudPoolId(p)} className="border-b border-gray-800/40 last:border-0 hover:bg-gray-800/20 transition-colors">
                <td className="px-4 py-2.5">
                  <span className="text-xs font-mono text-teal-300">{p.provisioner}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-xs font-mono text-gray-300 break-all">{p.name}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs font-mono font-medium tabular-nums ${pendingColor(p.pending, 200, 50)}`}>{p.pending.toLocaleString()}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{p.running}</td>
                <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{p.total}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${load >= 90 ? "bg-orange-400" : load >= 60 ? "bg-yellow-400" : "bg-emerald-400"}`}
                        style={{ width: `${Math.min(load, 100)}%` }} />
                    </div>
                    <span className="text-xs text-gray-600 tabular-nums">{load}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PinnedEditor({ allPools, selected, defaults, onSave, onClose }: {
  allPools: PoolHealth[];
  selected: string[];
  defaults: string[];
  onSave: (next: string[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<string[]>(selected);
  const [filter, setFilter] = useState("");
  const [dragChip, setDragChip] = useState<number | null>(null);

  const toggle = (name: string) =>
    setDraft(d =>
      d.includes(name)
        ? d.filter(n => n !== name)
        : d.length >= MAX_PINNED ? d : [...d, name]
    );

  const names = [...new Set(allPools.map(p => p.name))].sort();
  const q = filter.trim().toLowerCase();
  const filtered = q ? names.filter(n => n.toLowerCase().includes(q)) : names;
  const atMax = draft.length >= MAX_PINNED;

  return (
    <div className="card p-5 space-y-4 border-brand-500/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">Edit tracked pools</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            Pick up to {MAX_PINNED} pools to pin at the top. {draft.length}/{MAX_PINNED} selected.
          </div>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors" title="Cancel">
          <X size={16} />
        </button>
      </div>

      {draft.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {draft.length > 1 && <span className="text-[10px] text-gray-600 self-center mr-0.5">drag to reorder:</span>}
          {draft.map((name, i) => (
            <span key={name}
              draggable
              onDragStart={() => setDragChip(i)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => { setDraft(d => (dragChip !== null && dragChip !== i ? reorder(d, dragChip, i) : d)); setDragChip(null); }}
              onDragEnd={() => setDragChip(null)}
              className={`flex items-center gap-1.5 text-xs font-mono bg-brand-900/20 text-brand-200 border border-brand-500/30 rounded-full pl-2 pr-1.5 py-1 cursor-grab active:cursor-grabbing ${dragChip === i ? "opacity-40" : ""}`}>
              <GripVertical size={11} className="text-brand-400/50" />
              <span className="text-brand-500 tabular-nums">{i + 1}</span>
              {name}
              <button onClick={() => toggle(name)} className="text-brand-400/70 hover:text-brand-200 transition-colors" title="Remove">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        type="text"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter pools…"
        className="w-full bg-gray-900/60 border border-gray-700/60 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500/50"
      />

      <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-800/60 divide-y divide-gray-800/40">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-xs text-gray-600">No pools match “{filter}”.</div>
        ) : filtered.map(name => {
          const isSel = draft.includes(name);
          const disabled = !isSel && atMax;
          return (
            <button
              key={name}
              onClick={() => toggle(name)}
              disabled={disabled}
              className={`flex items-center gap-2 w-full text-left px-3 py-2 text-xs font-mono transition-colors ${
                isSel ? "bg-brand-900/15 text-brand-200" : disabled ? "text-gray-700 cursor-not-allowed" : "text-gray-300 hover:bg-gray-800/40"
              }`}>
              <span className={`flex items-center justify-center w-3.5 h-3.5 rounded border flex-shrink-0 ${
                isSel ? "bg-brand-500 border-brand-500" : "border-gray-600"
              }`}>
                {isSel && <Check size={10} className="text-white" />}
              </span>
              {name}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          onClick={() => setDraft(defaults)}
          className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors">
          <RotateCcw size={11} /> Reset to default
        </button>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onSave(draft)}
            className="flex items-center gap-1.5 text-xs font-medium bg-brand-500/15 text-brand-200 border border-brand-500/30 rounded-lg px-3 py-1.5 hover:bg-brand-500/25 transition-colors">
            <Check size={12} /> {draft.length === 0 ? "Save (none)" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MacHardwareCard({ summary }: { summary: FleetSummary }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          <Cpu size={13} className="text-gray-500" /> Mac Hardware
        </h3>
        <span className="text-[10px] font-medium text-gray-600 uppercase tracking-wider bg-gray-800/60 border border-gray-700/50 rounded px-2 py-0.5">source: MDM</span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-gray-800">
        <div className="pr-5">
          <div className="text-3xl font-bold tabular-nums text-indigo-400">{(summary.by_generation_mdm.r8 ?? 0).toLocaleString()}</div>
          <div className="text-xs font-mono text-gray-500 mt-1">r8 <span className="text-gray-600">· Intel Mac mini</span></div>
        </div>
        <div className="pl-5">
          <div className="text-3xl font-bold tabular-nums text-emerald-400">{(summary.by_generation_mdm.m4 ?? 0).toLocaleString()}</div>
          <div className="text-xs font-mono text-gray-500 mt-1">m4 <span className="text-gray-600">· Apple Silicon</span></div>
        </div>
      </div>
    </div>
  );
}

function NeedsAttentionCard({ summary }: { summary: FleetSummary }) {
  const items = [
    { label: "Quarantined",     value: summary.attention_mac.quarantined,     color: "text-red-400",    to: "/workers?tc_quarantined=true" },
    { label: "Missing from TC", value: summary.attention_mac.missing_from_tc, color: "text-orange-400", to: "/alerts" },
  ];
  const attention = items.reduce((s, a) => s + a.value, 0);
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          <ShieldOff size={13} className="text-gray-500" /> Needs Attention
          <span className="text-[10px] font-medium text-gray-600 normal-case tracking-normal">· macOS hardware</span>
        </h3>
        <Link to="/alerts" className="text-[11px] text-brand-400 hover:text-brand-300 transition-colors">View alerts →</Link>
      </div>
      {attention === 0 ? (
        <div className="flex items-center gap-2 text-sm text-emerald-400 py-3">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Nothing needs attention
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map(item => (
            <Link key={item.label} to={item.to} className="flex items-center justify-between group">
              <span className="text-xs text-gray-400 group-hover:text-gray-200 transition-colors">{item.label}</span>
              <span className={`text-lg font-bold tabular-nums ${item.value > 0 ? item.color : "text-gray-700"}`}>{item.value}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function PinnedGrid({ pools, pending, sources, onReorder }: {
  pools: PoolHealth[];
  pending: Record<string, number | null>;
  sources: Record<string, PoolSources>;
  onReorder: (names: string[]) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const cols = pools.length >= 4 ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3";

  const drop = (to: number) => {
    if (dragIdx !== null && dragIdx !== to) onReorder(reorder(pools.map(p => p.name), dragIdx, to));
    setDragIdx(null);
    setOverIdx(null);
  };

  return (
    <div className={`grid grid-cols-1 gap-4 ${cols}`}>
      {pools.map((pool, i) => (
        <div key={pool.name}
          draggable
          onDragStart={() => setDragIdx(i)}
          onDragOver={e => { e.preventDefault(); if (overIdx !== i) setOverIdx(i); }}
          onDrop={e => { e.preventDefault(); drop(i); }}
          onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
          className={`group relative rounded-xl cursor-grab active:cursor-grabbing transition-all ${
            dragIdx === i ? "opacity-40" : ""
          } ${overIdx === i && dragIdx !== null && dragIdx !== i ? "ring-2 ring-brand-500/60" : ""}`}>
          <div className="absolute top-2.5 right-2.5 z-10 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <GripVertical size={14} />
          </div>
          <PinnedCard pool={pool} pending={pending[pool.name] ?? null} sources={sources[pool.name]} />
        </div>
      ))}
    </div>
  );
}

export function Pools() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const section = searchParams.get("section") || "mac";
  const [pools, setPools] = useState<PoolHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [pending, setPending] = useState<Record<string, number | null>>({});
  const [sources, setSources] = useState<Record<string, PoolSources>>({});
  const [cloudPoolData, setCloudPoolData] = useState<CloudPool[]>([]);
  const [androidPoolData, setAndroidPoolData] = useState<CloudPool[]>([]);
  const [branchOverrides, setBranchOverrides] = useState<FleetSummary["branch_overrides"] | null>(null);
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  const [roninPRs, setRoninPRs] = useState<RoninPR[]>([]);
  const [pinnedPools, setPinnedPools] = useState<string[]>([]);
  const [trackedMap, setTrackedMap] = useState<Record<string, string[]> | null>(null);
  const [editingPinned, setEditingPinned] = useState(false);
  const toggleOther = useCallback(() => setShowOther(v => !v), []);

  const persistPinned = useCallback((next: string[]) => {
    setPinnedPools(next);
    setTrackedMap(m => ({ ...(m ?? {}), [section]: next }));
    api.me.setTrackedPools(section, next).catch(() => {});
  }, [section]);

  const updatePinned = useCallback((next: string[]) => {
    persistPinned(next);
    setEditingPinned(false);
  }, [persistPinned]);

  // The user's tracked pools (per section) follow them via the IAP-backed backend store.
  useEffect(() => {
    api.me.trackedPools().then(d => setTrackedMap(d.tracked ?? {})).catch(() => setTrackedMap({}));
  }, []);

  // Close the editor when switching tabs.
  useEffect(() => { setEditingPinned(false); }, [section]);

  // Resolve the active section's pinned set once pools + the user's tracked map are loaded.
  useEffect(() => {
    if (pools.length === 0 || trackedMap === null) return;
    const avail = pools
      .filter(p => section === "linux" ? isLinuxPool(p.name)
        : section === "windows" ? isWindowsPool(p.name)
        : !isLinuxPool(p.name) && !isWindowsPool(p.name))
      .map(p => p.name);
    const saved = trackedMap[section];
    if (saved !== undefined) {
      // Respect an explicit set — including an empty one (the user chose to track nothing).
      setPinnedPools(saved.slice(0, MAX_PINNED));
      return;
    }
    // No server-side set yet — migrate any legacy localStorage pins, else fall back to defaults.
    const legacy = legacyLocalPinned(section);
    if (legacy.length > 0) {
      setPinnedPools(legacy);
      setTrackedMap(m => ({ ...(m ?? {}), [section]: legacy }));
      api.me.setTrackedPools(section, legacy).catch(() => {});
      try { localStorage.removeItem(pinnedStorageKey(section)); } catch { /* ignore */ }
    } else {
      setPinnedPools(defaultPinned(section, avail));
    }
  }, [section, pools, trackedMap]);

  useEffect(() => {
    api.fleet.pools()
      .then(d => setPools(d.pools))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));

    api.fleet.pendingCounts()
      .then(d => setPending(d.pending_counts))
      .catch(() => {});

    api.fleet.cloudPools()
      .then(d => setCloudPoolData(d.pools))
      .catch(() => {});
    api.fleet.androidPools()
      .then(d => setAndroidPoolData(d.pools))
      .catch(() => {});
    api.fleet.summary()
      .then(d => { setBranchOverrides(d.branch_overrides); setSummary(d); })
      .catch(() => {});
    api.prs.list()
      .then(d => setRoninPRs(d.prs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    for (const poolName of pinnedPools) {
      api.fleet.poolSources(poolName)
        .then(s => setSources(prev => ({ ...prev, [poolName]: s })))
        .catch(() => {});
    }
  }, [pinnedPools]);

  useEffect(() => {
    const names = pools.filter(p => isLinuxPool(p.name) || isWindowsPool(p.name)).map(p => p.name);
    for (const poolName of names) {
      api.fleet.poolSources(poolName)
        .then(s => setSources(prev => ({ ...prev, [poolName]: s })))
        .catch(() => {});
    }
  }, [pools]);

  useEffect(() => {
    for (const pool of androidPoolData) {
      api.fleet.androidPoolSources(pool.name)
        .then(s => setSources(prev => ({ ...prev, [pool.name]: s })))
        .catch(() => {});
    }
  }, [androidPoolData]);

  if (error) return <div className="p-8 text-red-400 text-sm">{error}</div>;
  if (loading) return (
    <div className="p-8 flex items-center gap-2 text-gray-600 text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" /> Loading pool data…
    </div>
  );

  const pinnedData = pinnedPools.map(name => pools.find(p => p.name === name)).filter(Boolean) as PoolHealth[];

  const linuxHwPools   = pools.filter(p => isLinuxPool(p.name));
  const windowsHwPools = pools.filter(p => isWindowsPool(p.name));
  const macPools       = pools.filter(p => !isLinuxPool(p.name) && !isWindowsPool(p.name));
  const signingPools = macPools.filter(p => p.name.includes("signing"));
  const vmPools      = macPools.filter(p => p.name.endsWith("-vms"));
  const builderPools = macPools.filter(p => !p.name.includes("signing") && !p.name.endsWith("-vms") && p.name.includes("-b-"));
  const testerPools  = macPools.filter(p => !p.name.includes("signing") && !p.name.endsWith("-vms") && !p.name.includes("-b-") && p.name.includes("-t-"));
  const otherPools   = macPools.filter(p => !p.name.includes("signing") && !p.name.endsWith("-vms") && !p.name.includes("-b-") && !p.name.includes("-t-"));

  // Tracked-pool support per section (mac / linux / windows)
  const trackSection = section === "mac" || section === "linux" || section === "windows";
  const sectionTrackPools = section === "linux" ? linuxHwPools : section === "windows" ? windowsHwPools : macPools;
  const sectionTrackDefaults = defaultPinned(section, sectionTrackPools.map(p => p.name));

  const totalWorkers = pools.reduce((s, p) => s + p.total, 0);
  const linuxCloudWorkers = cloudPoolData.reduce((s, p) => s + p.total, 0);
  const totalIssues  = testerPools.reduce((s, p) => s + p.quarantined + p.mdm_unenrolled, 0);
  const totalBranch  = testerPools.reduce((s, p) => s + p.branch_override_count, 0);

  const sectionPoolCount =
    section === "mac"     ? macPools.length
    : section === "linux"   ? linuxHwPools.length + cloudPoolData.length
    : section === "windows" ? windowsHwPools.length
    : section === "android" ? androidPoolData.length
    : pools.length;

  const sectionWorkerCount =
    section === "mac"     ? macPools.reduce((s, p) => s + p.total, 0)
    : section === "linux"   ? linuxHwPools.reduce((s, p) => s + p.total, 0) + linuxCloudWorkers
    : section === "windows" ? windowsHwPools.reduce((s, p) => s + p.total, 0)
    : section === "android" ? androidPoolData.reduce((s, p) => s + p.total, 0)
    : totalWorkers;

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="w-1 h-9 rounded-full flex-shrink-0" style={{ backgroundImage: FF_GRADIENT }} />
          <div>
            <h1 className="text-2xl font-light text-white tracking-tight">Pool Health</h1>
            <p className="text-gray-500 text-sm mt-0.5">{sectionPoolCount} pools · {sectionWorkerCount.toLocaleString()} workers</p>
          </div>
        </div>
        {section === "mac" && (
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
        )}
      </div>

      {trackSection && (
        <div className="space-y-3">
          {(pinnedData.length > 0 || editingPinned) && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-gray-600">
                Tracked pools{pinnedData.length > 1 ? " · drag to reorder" : ""}
              </span>
              {!editingPinned && (
                <button
                  onClick={() => setEditingPinned(true)}
                  className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors">
                  <Pencil size={11} /> Edit tracked pools
                </button>
              )}
            </div>
          )}
          {editingPinned && (
            <PinnedEditor
              allPools={sectionTrackPools}
              selected={pinnedPools}
              defaults={sectionTrackDefaults}
              onSave={updatePinned}
              onClose={() => setEditingPinned(false)}
            />
          )}
          {pinnedData.length > 0 ? (
            <PinnedGrid pools={pinnedData} pending={pending} sources={sources} onReorder={persistPinned} />
          ) : !editingPinned ? (
            <button
              onClick={() => setEditingPinned(true)}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-gray-800/80 text-[11px] text-gray-600 hover:border-gray-700 hover:text-gray-400 transition-colors">
              <Pin size={12} /> Track pools to pin them here
            </button>
          ) : null}
        </div>
      )}

      {section === "mac" && summary && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <MacHardwareCard summary={summary} />
          <NeedsAttentionCard summary={summary} />
        </div>
      )}

      {section === "mac" && <MacMigrationCard />}

      {/* macOS sub-page: full detail */}
      {section === "mac" && testerPools.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <FlaskConical size={12} /> Tester Pools
          </h2>
          <PoolTable pools={testerPools} pinnedPools={[]} navigate={navigate} showLegend pending={pending} />
        </div>
      )}

      {section === "mac" && builderPools.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
            <Hammer size={12} /> Builder Pools
          </h2>
          <p className="text-[11px] text-gray-600 mb-3">Build workers — identified by <span className="font-mono">-b-</span> in pool name.</p>
          <PoolTable pools={builderPools} pinnedPools={[]} navigate={navigate} showLegend={false} pending={pending} />
        </div>
      )}

      {section === "mac" && vmPools.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
            <Monitor size={12} /> VM Pools
          </h2>
          <p className="text-[11px] text-gray-600 mb-3">Virtual machine pools running on Apple Silicon hosts.</p>
          <PoolTable pools={vmPools} pinnedPools={[]} navigate={navigate} showLegend={false} pending={pending} />
        </div>
      )}

      {section === "mac" && signingPools.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-2">
            <Lock size={12} /> Signing Pools
          </h2>
          <p className="text-[11px] text-gray-600 mb-3">
            Signing workers operate differently — activity and health metrics may not reflect actual pool status.
          </p>
          <PoolTable pools={signingPools} pinnedPools={[]} navigate={navigate} showLegend={false} pending={pending} />
        </div>
      )}

      {section === "linux" && linuxHwPools.length > 0 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Terminal size={12} /> All Linux Hardware Pools
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/35 border border-emerald-900/40 rounded px-1.5 py-0.5 normal-case tracking-normal">
                releng-hardware
              </span>
            </h2>
            <PoolTable pools={linuxHwPools} pinnedPools={[]} navigate={navigate} showLegend pending={pending} showProvisioner />
          </div>
        </div>
      )}

      {section === "windows" && windowsHwPools.length > 0 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Terminal size={12} /> All Windows Hardware Pools
            </h2>
            <PoolTable pools={windowsHwPools} pinnedPools={[]} navigate={navigate} showLegend pending={pending} />
          </div>
        </div>
      )}

      {section === "linux" && cloudPoolData.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-0.5 h-5 bg-teal-500 rounded-full" />
            <span className="text-sm font-semibold text-gray-300 tracking-tight">Linux Cloud</span>
            <span className="text-xs text-gray-600">
              {cloudPoolData.length} pools · {linuxCloudWorkers.toLocaleString()} workers · {provisionerSummary(cloudPoolData)}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {cloudPoolData.map(p => <CloudPoolCard key={cloudPoolId(p)} pool={p} />)}
          </div>
          {section === "linux" && (
            <div>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Terminal size={12} /> All Linux Cloud Pools
              </h2>
              <CloudPoolTable pools={cloudPoolData} />
            </div>
          )}
        </div>
      )}

      {section === "android" && androidPoolData.length > 0 && (
        <div className="space-y-6">
          <AndroidPoolCards pools={androidPoolData} sources={sources} />
          <div>
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Smartphone size={12} /> All Android Hardware Pools
            </h2>
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800/80">
                    {["Pool", "Device", "Infra", "Pending", "Running", "Total", "Load"].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-gray-600 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {androidPoolData.map(p => {
                    const load = p.total > 0 ? Math.round((p.running / p.total) * 100) : 0;
                    const isLambda = p.name.includes("lambda");
                    const deviceLabel = p.name.includes("a55") ? "Samsung A55"
                      : p.name.includes("p6") ? "Pixel 6"
                      : p.name.includes("s24") ? "Galaxy S24"
                      : p.name.includes("p5") ? "Pixel 5"
                      : "—";
                    return (
                      <tr key={cloudPoolId(p)} className="border-b border-gray-800/40 last:border-0 hover:bg-gray-800/20 transition-colors">
                        <td className="px-4 py-2.5 text-xs font-mono text-gray-300">{p.name}</td>
                        <td className="px-4 py-2.5 text-xs text-green-400 font-medium">{deviceLabel}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{isLambda ? "Lambda" : "Bitbar"}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs font-mono font-medium tabular-nums ${pendingColor(p.pending, 50, 10)}`}>{p.pending.toLocaleString()}</span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{p.running}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{p.total}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${load >= 90 ? "bg-orange-400" : load >= 60 ? "bg-yellow-400" : "bg-emerald-400"}`}
                                style={{ width: `${load}%` }} />
                            </div>
                            <span className="text-xs text-gray-600 tabular-nums">{load}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {section === "mac" && roninPRs.length > 0 && (
        <RoninPRPanel prs={roninPRs} onVote={(updated) =>
          setRoninPRs(prev => prev.map(p => p.number === updated.number ? updated : p))
        } />
      )}

      {section === "mac" && otherPools.length > 0 && (
        <div>
          <button onClick={toggleOther}
            className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-400 transition-colors mb-3">
            <Users size={12} />
            Other
            <span className="text-gray-700 normal-case font-normal tracking-normal">({otherPools.length})</span>
            <ChevronDown size={12} className={`transition-transform ${showOther ? "rotate-180" : ""}`} />
          </button>
          {showOther && <PoolTable pools={otherPools} pinnedPools={[]} navigate={navigate} showLegend={false} pending={pending} />}
        </div>
      )}

      {section === "mac" && branchOverrides && branchOverrides.total > 0 && (
        <div className="card p-5">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
            <GitBranch size={12} /> Branch Overrides
            <span className="ml-1 text-amber-400 font-bold">{branchOverrides.total}</span>
            <span className="text-gray-600 font-normal">workers pinned to a non-default branch</span>
          </h3>
          <div className="flex flex-wrap gap-6">
            <div>
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">By Branch</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(branchOverrides.by_branch).sort((a, b) => b[1] - a[1]).map(([branch, count]) => (
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
                {Object.entries(branchOverrides.by_pool).sort((a, b) => b[1] - a[1]).map(([pool, count]) => (
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

const LABEL_COLORS: Record<string, string> = {
  "Mac Improvement": "bg-amber-950/40 border-amber-800/50 text-amber-300",
  "Mac Feature":     "bg-blue-950/40 border-blue-800/50 text-blue-300",
};

function RoninPRPanel({ prs, onVote }: { prs: RoninPR[]; onVote: (pr: RoninPR) => void }) {
  const [voting, setVoting] = useState<Record<number, boolean>>({});

  async function vote(pr: RoninPR, dir: "up" | "down") {
    if (voting[pr.number]) return;
    setVoting(v => ({ ...v, [pr.number]: true }));
    try {
      const updated = await (dir === "up" ? api.prs.upvote(pr.number) : api.prs.downvote(pr.number));
      onVote(updated);
    } finally {
      setVoting(v => ({ ...v, [pr.number]: false }));
    }
  }

  return (
    <div className="card p-5">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
        <GitBranch size={12} /> Incoming Changes
        <span className="ml-1 text-gray-400 font-bold">{prs.length}</span>
      </h3>
      <div className="space-y-2">
        {prs.map(pr => (
          <div key={pr.number} className="flex items-center gap-3 rounded-lg bg-gray-800/40 border border-gray-700/40 px-4 py-3">
            <span className="text-xs font-mono text-gray-600 tabular-nums w-10 shrink-0">#{pr.number}</span>
            <a href={pr.url} target="_blank" rel="noopener noreferrer"
              className="flex-1 text-sm text-gray-200 hover:text-white transition-colors truncate">
              {pr.title}
            </a>
            <div className="flex items-center gap-1.5 shrink-0">
              {pr.labels.map(l => (
                <span key={l} className={`text-[10px] font-medium px-2 py-0.5 rounded border ${LABEL_COLORS[l] ?? "bg-gray-800 border-gray-700 text-gray-400"}`}>
                  {l}
                </span>
              ))}
            </div>
            {pr.author && (
              <span className="text-xs text-gray-600 shrink-0 hidden lg:block">{pr.author}</span>
            )}
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => vote(pr, "up")}
                disabled={voting[pr.number]}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/30 transition-colors disabled:opacity-40">
                ▲ <span className="tabular-nums">{pr.upvotes}</span>
              </button>
              <button
                onClick={() => vote(pr, "down")}
                disabled={voting[pr.number]}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-red-400 hover:bg-red-950/30 transition-colors disabled:opacity-40">
                ▼ <span className="tabular-nums">{pr.downvotes}</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
