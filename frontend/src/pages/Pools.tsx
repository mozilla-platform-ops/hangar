import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Pin, AlertTriangle, GitBranch, Users, Lock, Hammer, FlaskConical, ChevronDown, Terminal, Smartphone, Monitor, Pencil, Check, X, RotateCcw, GripVertical, Cpu, Link2 } from "lucide-react";
import { api } from "../api";
import type { PoolHealth, PoolSources, CloudPool, FleetSummary, RoninPR, PoolSeries, PoolLoadSnapshot } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { PROJECT_COLORS, PROJECT_TEXT } from "../lib/projects";
import { MacMigrationCard } from "../components/Showcase";
import { ReprovisionActivity } from "../components/ReprovisionActivity";
import { MonitoredPoolCard } from "../components/MonitoredPoolCard";
import { usePoll } from "../lib/useLive";

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

function isLinuxPool(name: string): boolean {
  return name.includes("linux");
}

function isWindowsPool(name: string): boolean {
  return name.includes("win");
}

// Family key = pool name with the trust-level token (1/3) and variant suffixes
// (staging/ipv6) stripped, so related pools collapse to the same group. e.g.
// gecko-1-b-osx-arm64 and gecko-3-b-osx-arm64 -> gecko-b-osx-arm64.
function poolFamilyKey(name: string): string {
  return name
    .split("-")
    .filter(seg => seg !== "1" && seg !== "3" && seg !== "staging" && seg !== "ipv6" && seg !== "dep")
    .join("-");
}

function poolLevel(name: string): number {
  const segs = name.split("-");
  if (segs.includes("3")) return 3;
  if (segs.includes("1")) return 1;
  return 0;
}

// Variant order within a family: staging first (sits above its prod
// counterpart), then production, then ipv6.
function poolVariantRank(name: string): number {
  if (name.endsWith("-staging")) return 0;
  if (name.endsWith("-ipv6")) return 2;
  return 1;
}

// Group related pools together and order families by their largest pool's Total
// (desc), keeping the big/important pools near the top. Within a family, order
// by trust level asc (1 before 3) then variant, so a staging pool sits directly
// above its production sibling (ipv6 sits just below).
function sortPoolsByFamily(pools: PoolHealth[]): PoolHealth[] {
  const familyMaxTotal = new Map<string, number>();
  for (const p of pools) {
    const key = poolFamilyKey(p.name);
    familyMaxTotal.set(key, Math.max(familyMaxTotal.get(key) ?? 0, p.total));
  }
  return [...pools].sort((a, b) => {
    const ka = poolFamilyKey(a.name), kb = poolFamilyKey(b.name);
    if (ka !== kb) {
      const diff = (familyMaxTotal.get(kb) ?? 0) - (familyMaxTotal.get(ka) ?? 0);
      return diff !== 0 ? diff : ka.localeCompare(kb);
    }
    const lvl = poolLevel(a.name) - poolLevel(b.name);
    if (lvl !== 0) return lvl;
    const variant = poolVariantRank(a.name) - poolVariantRank(b.name);
    if (variant !== 0) return variant;
    return a.name.localeCompare(b.name);
  });
}

// Signing pools: all production pools first, then the dep block. Both blocks use
// the same product order (family by largest total, then name) so they read as
// two parallel columns — e.g. gecko, comm, … then dep-gecko, dep-comm, ….
function sortSigningPools(pools: PoolHealth[]): PoolHealth[] {
  const familyMaxTotal = new Map<string, number>();
  for (const p of pools) {
    const key = poolFamilyKey(p.name);
    familyMaxTotal.set(key, Math.max(familyMaxTotal.get(key) ?? 0, p.total));
  }
  const isDep = (n: string) => n.startsWith("dep-");
  return [...pools].sort((a, b) => {
    if (isDep(a.name) !== isDep(b.name)) return isDep(a.name) ? 1 : -1;  // prod block, then dep block
    const ka = poolFamilyKey(a.name), kb = poolFamilyKey(b.name);
    const diff = (familyMaxTotal.get(kb) ?? 0) - (familyMaxTotal.get(ka) ?? 0);
    return diff !== 0 ? diff : ka.localeCompare(kb);
  });
}

function cloudPoolId(pool: CloudPool): string {
  return pool.id || `${pool.provisioner}/${pool.name}`;
}

function provisionerSummary(pools: CloudPool[]): string {
  const provisioners = [...new Set(pools.map(p => p.provisioner))].sort();
  return provisioners.length === 1 ? provisioners[0] : `${provisioners.length} provisioners`;
}

function pendingColor(n: number | null | undefined, highThreshold = 500, midThreshold = 100): string {
  if (n == null) return "text-gray-600";
  if (n === 0)              return "text-emerald-400";
  if (n <= midThreshold)    return "text-emerald-400";
  if (n <= highThreshold)   return "text-yellow-400";
  return "text-orange-300";
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


// Anchored section heading: gives each pool section a stable id so it can be
// deep-linked (e.g. #signing-pools) and reveals a copyable link icon on hover.
// scroll-mt keeps the target clear of the top edge when jumped to.
function SectionHeading({ id, icon, title, className = "mb-1", children }: {
  id: string;
  icon: ReactNode;
  title: string;
  className?: string;
  children?: ReactNode;  // optional trailing content (e.g. a provisioner badge)
}) {
  return (
    <h2 id={id} className={`group scroll-mt-6 text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2 ${className}`}>
      {icon} {title}
      {children}
      <a href={`#${id}`} aria-label={`Link to ${title}`}
        className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-gray-300 transition-opacity">
        <Link2 size={11} />
      </a>
    </h2>
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
                      <span className="text-xs font-mono text-gray-300">{pool.provisioner}</span>
                    ) : <span className="text-xs text-gray-700">—</span>}
                  </td>
                )}
                <td className="px-4 py-2.5">
                  <span className="text-xs font-mono font-medium text-gray-300">{poolGeneration(pool) || "?"}</span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pool.health_score * 100}%`, backgroundImage: FF_GRADIENT }} />
                    </div>
                    <span className="text-xs font-mono tabular-nums text-gray-300">{Math.round(pool.health_score * 100)}%</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 min-w-[100px]"><ActivityBar pool={pool} /></td>
                <td className="px-4 py-2.5">
                  {p != null ? (
                    <span className="text-xs font-mono tabular-nums font-medium text-gray-300">
                      {p.toLocaleString()}
                    </span>
                  ) : <span className="text-xs text-gray-700">—</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{pool.total}</td>
                <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{pool.production}</td>
                <td className="px-4 py-2.5">
                  <span className="text-xs tabular-nums font-medium text-gray-300">
                    {pool.running_tasks ?? 0}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-xs tabular-nums text-gray-300">{pool.active_24h}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs tabular-nums ${stale > 0 ? "text-gray-300" : "text-gray-700"}`}>{stale || "—"}</span>
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
  const isAndroid = pool.provisioner === "proj-autophone";
  const isLambda = pool.name.includes("lambda");
  const isAlpha = pool.name.includes("alpha");
  const deviceLabel = pool.name.includes("a55") ? "Samsung A55"
    : pool.name.includes("p6") ? "Pixel 6"
    : pool.name.includes("s24") ? "Galaxy S24"
    : pool.name.includes("p5") ? "Pixel 5"
    : null;
  const infra = isLambda ? "Lambda" : isAndroid ? "Bitbar" : "Linux Cloud";
  const fullPoolId = cloudPoolId(pool);
  const [showSubmitters, setShowSubmitters] = useState(false);
  const submitterCount = sources ? Object.keys(sources.by_user).length : 0;

  return (
    <div className="card p-5 flex flex-col gap-4">
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
            ? <span className="text-xs text-gray-300 font-medium">{deviceLabel}</span>
            : <span className="text-xs text-gray-500 font-mono">{infra}</span>
          }
          {isAlpha && <span className="text-[10px] bg-purple-900/40 text-purple-400 border border-purple-800/40 px-1.5 py-0.5 rounded-full">alpha</span>}
          {deviceLabel && <span className="text-[10px] text-gray-600">{infra}</span>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 bg-gray-800/30 rounded-lg p-3 border border-gray-700/30">
        <div>
          <div className="text-2xl font-bold tabular-nums text-white leading-none">
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
          <button type="button" onClick={() => setShowSubmitters(s => !s)}
            className="flex items-center gap-1.5 w-full text-[10px] text-gray-500 hover:text-gray-300 uppercase tracking-wider transition-colors">
            Top Submitters
            {submitterCount > 0 && <span className="normal-case tracking-normal text-gray-600">· {submitterCount}</span>}
            <ChevronDown size={12} className={`ml-auto transition-transform ${showSubmitters ? "rotate-180" : ""}`} />
          </button>
          {showSubmitters && (
            <div className="space-y-1 mt-2">
              {submitterCount === 0 ? (
                <div className="text-[10px] text-gray-700">No submitters in sample</div>
              ) : Object.entries(sources.by_user).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([user, count], i) => {
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
          )}
        </div>
      )}
    </div>
  );
}


function AndroidPoolCards({ pools, sources, seriesMap }: { pools: CloudPool[]; sources: Record<string, PoolSources>; seriesMap: Record<string, PoolSeries> }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {pools.map(p => (
        <MonitoredPoolCard key={cloudPoolId(p)} name={p.name}
          pending={p.pending} running={p.running} capacity={p.total}
          series={seriesMap[p.name]} sources={sources[p.name]} />
      ))}
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
                      <div className="h-full rounded-full"
                        style={{ width: `${Math.min(load, 100)}%`, backgroundImage: FF_GRADIENT }} />
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

/** Fleet composition as a single full-width strip: a proportional Intel-vs-Apple-Silicon
 *  bar with counts + share. Sits at the bottom of the macOS page as a closing summary. */
function MacHardwareCard({ summary }: { summary: FleetSummary }) {
  const r8 = summary.by_generation_mdm.r8 ?? 0;
  const m4 = summary.by_generation_mdm.m4 ?? 0;
  const total = r8 + m4;
  const r8pct = total > 0 ? Math.round((r8 / total) * 100) : 0;
  const m4pct = total > 0 ? 100 - r8pct : 0;
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          <Cpu size={13} className="text-gray-500" /> Mac Hardware
          <span className="text-[10px] font-medium text-gray-600 normal-case tracking-normal">· fleet composition · {total.toLocaleString()} minis</span>
        </h3>
        <span className="text-[10px] font-medium text-gray-600 uppercase tracking-wider bg-gray-800/60 border border-gray-700/50 rounded px-2 py-0.5">source: MDM</span>
      </div>
      {/* proportional Intel ▸ Apple Silicon split */}
      <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-800">
        <div className="h-full bg-indigo-500/80" style={{ width: `${r8pct}%` }} />
        <div className="h-full bg-emerald-500/80" style={{ width: `${m4pct}%` }} />
      </div>
      <div className="flex items-center justify-between mt-3">
        <div className="flex items-baseline gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-400 self-center" />
          <span className="text-2xl font-bold tabular-nums text-indigo-400">{r8.toLocaleString()}</span>
          <span className="text-xs font-mono text-gray-500">r8 · Intel Mac mini <span className="text-gray-600">· {r8pct}%</span></span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-mono text-gray-500"><span className="text-gray-600">{m4pct}% ·</span> m4 · Apple Silicon</span>
          <span className="text-2xl font-bold tabular-nums text-emerald-400">{m4.toLocaleString()}</span>
          <span className="w-2 h-2 rounded-full bg-emerald-400 self-center" />
        </div>
      </div>
    </div>
  );
}

function PinnedGrid({ pools, pending, sources, seriesMap, loadByName, onReorder }: {
  pools: PoolHealth[];
  pending: Record<string, number | null>;
  sources: Record<string, PoolSources>;
  seriesMap: Record<string, PoolSeries>;
  loadByName: Record<string, PoolLoadSnapshot>;
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
          <MonitoredPoolCard name={pool.name}
            pending={loadByName[pool.name]?.pending ?? pending[pool.name] ?? null}
            running={loadByName[pool.name]?.running ?? null}
            capacity={loadByName[pool.name]?.capacity ?? null}
            sources={sources[pool.name]} series={seriesMap?.[pool.name]} />
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
  const [seriesMap, setSeriesMap] = useState<Record<string, PoolSeries>>({});
  const [loadByName, setLoadByName] = useState<Record<string, PoolLoadSnapshot>>({});
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

  // Deep-link support: once data has loaded and the sections have rendered,
  // scroll to the anchor in the URL hash (e.g. /pools?section=mac#signing-pools).
  useEffect(() => {
    if (loading) return;
    const id = window.location.hash.slice(1);
    if (!id) return;
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    // cloud/android pools load into separate state after the initial pools fetch,
    // so re-run when their counts change to catch anchors in those sections.
  }, [loading, section, cloudPoolData.length, androidPoolData.length]);

  useEffect(() => {
    api.fleet.pools()
      .then(d => setPools(d.pools))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));

    api.fleet.pendingCounts()
      .then(d => setPending(d.pending_counts))
      .catch(() => {});

    api.fleet.loadHistory(24, true)
      .then(d => {
        setSeriesMap(d.pool_series ?? {});
        setLoadByName(Object.fromEntries((d.pools ?? []).map(p => [p.pool, p])));
      })
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

  // Keep the dashboard live. DB-backed endpoints poll faster than the ones that
  // fan out to live Taskcluster queries server-side.
  usePoll(() => {
    api.fleet.pools().then(d => setPools(d.pools)).catch(() => {});
    api.fleet.pendingCounts().then(d => setPending(d.pending_counts)).catch(() => {});
    api.fleet.loadHistory(24, true).then(d => {
      setSeriesMap(d.pool_series ?? {});
      setLoadByName(Object.fromEntries((d.pools ?? []).map(p => [p.pool, p])));
    }).catch(() => {});
    api.fleet.summary().then(d => { setBranchOverrides(d.branch_overrides); setSummary(d); }).catch(() => {});
  }, 120_000);
  usePoll(() => {
    api.fleet.cloudPools().then(d => setCloudPoolData(d.pools)).catch(() => {});
    api.fleet.androidPools().then(d => setAndroidPoolData(d.pools)).catch(() => {});
  }, 300_000);

  useEffect(() => {
    for (const poolName of pinnedPools) {
      api.fleet.poolSources(poolName)
        .then(s => setSources(prev => ({ ...prev, [poolName]: s })))
        .catch(() => {});
    }
  }, [pinnedPools]);

  // Keyed on the name set (not array identity) so polling refreshes above don't
  // re-trigger the expensive per-pool task sampling.
  const linuxWindowsNames = pools.filter(p => isLinuxPool(p.name) || isWindowsPool(p.name)).map(p => p.name).sort().join(",");
  useEffect(() => {
    for (const poolName of linuxWindowsNames.split(",").filter(Boolean)) {
      api.fleet.poolSources(poolName)
        .then(s => setSources(prev => ({ ...prev, [poolName]: s })))
        .catch(() => {});
    }
  }, [linuxWindowsNames]);

  const androidNames = androidPoolData.map(p => p.name).sort().join(",");
  useEffect(() => {
    for (const poolName of androidNames.split(",").filter(Boolean)) {
      api.fleet.androidPoolSources(poolName)
        .then(s => setSources(prev => ({ ...prev, [poolName]: s })))
        .catch(() => {});
    }
  }, [androidNames]);

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
  // Signing pools we surface are the v4 scriptworkers (scriptworker-prov-v1),
  // which report full TC activity/health metrics. The legacy puppet-managed
  // signing pools have no TC data and are not shown on the macOS page.
  const scriptworkerPools = sortSigningPools(macPools.filter(p => p.name.includes("signing") && p.provisioner === "scriptworker-prov-v1"));
  // Tester VM pools (e.g. gecko-t-osx-1500-m-vms) live with the Tester pools;
  // only non-tester VM pools get their own VM section.
  const vmPools      = macPools.filter(p => p.name.endsWith("-vms") && !p.name.includes("-t-"));
  const builderPools = sortPoolsByFamily(macPools.filter(p => !p.name.includes("signing") && !p.name.endsWith("-vms") && p.name.includes("-b-")));
  const testerPools  = sortPoolsByFamily(macPools.filter(p => !p.name.includes("signing") && !p.name.includes("-b-") && p.name.includes("-t-")));
  // Non-worker buckets we don't surface on the macOS page: "unknown" (hosts with
  // no worker_pool) and the deploystudio imaging pool.
  const HIDDEN_MAC_POOLS = new Set(["unknown", "deploystudio"]);
  const otherPools   = macPools.filter(p => !p.name.includes("signing") && !p.name.endsWith("-vms") && !p.name.includes("-b-") && !p.name.includes("-t-") && !HIDDEN_MAC_POOLS.has(p.name));

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
                Monitored pools{pinnedData.length > 1 ? " · drag to reorder" : ""}
              </span>
              {!editingPinned && (
                <button
                  onClick={() => setEditingPinned(true)}
                  className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-300 transition-colors">
                  <Pencil size={11} /> Edit monitored pools
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
            <PinnedGrid pools={pinnedData} pending={pending} sources={sources} seriesMap={seriesMap} loadByName={loadByName} onReorder={persistPinned} />
          ) : !editingPinned ? (
            <button
              onClick={() => setEditingPinned(true)}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-gray-800/80 text-[11px] text-gray-600 hover:border-gray-700 hover:text-gray-400 transition-colors">
              <Pin size={12} /> Monitor pools to pin them here
            </button>
          ) : null}
        </div>
      )}

      {/* Fleet composition summary — sits below Monitored pools, above the pool tables */}
      {section === "mac" && summary && <MacHardwareCard summary={summary} />}

      {section === "mac" && <ReprovisionActivity />}

      {/* macOS sub-page: full detail */}
      {section === "mac" && testerPools.length > 0 && (
        <div>
          <SectionHeading id="tester-pools" icon={<FlaskConical size={12} />} title="Tester Pools" className="mb-3" />
          <PoolTable pools={testerPools} pinnedPools={[]} navigate={navigate} showLegend pending={pending} />
        </div>
      )}

      {section === "mac" && builderPools.length > 0 && (
        <div>
          <SectionHeading id="builder-pools" icon={<Hammer size={12} />} title="Builder Pools" />
          <p className="text-[11px] text-gray-600 mb-3">Build workers — identified by <span className="font-mono">-b-</span> in pool name.</p>
          <PoolTable pools={builderPools} pinnedPools={[]} navigate={navigate} showLegend={false} pending={pending} />
        </div>
      )}

      {section === "mac" && vmPools.length > 0 && (
        <div>
          <SectionHeading id="vm-pools" icon={<Monitor size={12} />} title="VM Pools" />
          <p className="text-[11px] text-gray-600 mb-3">Virtual machine pools running on Apple Silicon hosts.</p>
          <PoolTable pools={vmPools} pinnedPools={[]} navigate={navigate} showLegend={false} pending={pending} />
        </div>
      )}

      {section === "mac" && scriptworkerPools.length > 0 && (
        <div>
          <SectionHeading id="signing-pools" icon={<Lock size={12} />} title="Signing Pools" />
          <p className="text-[11px] text-gray-600 mb-3">
            v4 signing workers on the <span className="font-mono">scriptworker-prov-v1</span> provisioner — live Taskcluster metrics.
          </p>
          <PoolTable pools={scriptworkerPools} pinnedPools={[]} navigate={navigate} showLegend pending={pending} />
        </div>
      )}

      {section === "mac" && <MacMigrationCard />}

      {section === "linux" && linuxHwPools.length > 0 && (
        <div className="space-y-6">
          <div>
            <SectionHeading id="linux-hardware-pools" icon={<Terminal size={12} />} title="All Linux Hardware Pools" className="mb-3">
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/35 border border-emerald-900/40 rounded px-1.5 py-0.5 normal-case tracking-normal">
                releng-hardware
              </span>
            </SectionHeading>
            <PoolTable pools={linuxHwPools} pinnedPools={[]} navigate={navigate} showLegend pending={pending} showProvisioner />
          </div>
        </div>
      )}

      {section === "windows" && windowsHwPools.length > 0 && (
        <div className="space-y-6">
          <div>
            <SectionHeading id="windows-hardware-pools" icon={<Terminal size={12} />} title="All Windows Hardware Pools" className="mb-3" />
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
              <SectionHeading id="linux-cloud-pools" icon={<Terminal size={12} />} title="All Linux Cloud Pools" className="mb-3" />
              <CloudPoolTable pools={cloudPoolData} />
            </div>
          )}
        </div>
      )}

      {section === "android" && androidPoolData.length > 0 && (
        <div className="space-y-6">
          <AndroidPoolCards pools={androidPoolData} sources={sources} seriesMap={seriesMap} />
          <div>
            <SectionHeading id="android-hardware-pools" icon={<Smartphone size={12} />} title="All Android Hardware Pools" className="mb-3" />
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
                        <td className="px-4 py-2.5 text-xs text-gray-300 font-medium">{deviceLabel}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{isLambda ? "Lambda" : "Bitbar"}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs font-mono font-medium tabular-nums ${pendingColor(p.pending, 50, 10)}`}>{p.pending.toLocaleString()}</span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{p.running}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 tabular-nums">{p.total}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                              <div className="h-full rounded-full"
                                style={{ width: `${load}%`, backgroundImage: FF_GRADIENT }} />
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
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2"
        title="Open ronin_puppet pull requests affecting the worker fleet">
        <GitBranch size={12} /> Open ronin_puppet Worker PRs
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
