import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Sparkline } from "./Sparkline";
import { FF_GRADIENT } from "../lib/brand";
import { PROJECT_COLORS, PROJECT_TEXT } from "../lib/projects";
import type { PoolSeries, PoolSources } from "../api";

// Detail sections (24h pending, job sources, top submitters) shared by the
// Overview and Platforms "Monitored Pools" cards.
function MonitoredPoolExtras({ series, sources }: { series?: PoolSeries; sources?: PoolSources | null }) {
  const [showSubmitters, setShowSubmitters] = useState(false);
  const pts = (series?.pending ?? []).map(v => v ?? 0);
  const total = sources?.sample_size ?? 0;
  const projects = total > 0 ? Object.entries(sources!.by_project) : [];
  const submitters = total > 0 ? Object.entries(sources!.by_user).slice(0, 3) : [];
  const submitterCount = total > 0 ? Object.keys(sources!.by_user).length : 0;
  // Whenever sources are provided (even an empty sample) we reserve the Job
  // Sources / Top Submitters space so every card in a grid stays the same height.
  const hasSourceData = sources != null;

  if (pts.length < 2 && !hasSourceData) return null;

  return (
    <div className="mt-3 space-y-3 border-t border-gray-800/60 pt-3">
      {/* Always reserve the sparkline row so cards stay the same height whether or
          not a pool has accumulated ≥2 load samples yet (e.g. newly-added pools). */}
      <div>
        <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-1">Pending · 24h</div>
        {pts.length >= 2 ? (
          <Sparkline points={pts} className="w-full h-8" animate={false} />
        ) : (
          <div className="w-full h-8 flex items-center justify-center rounded bg-gray-800/20">
            <span className="text-[10px] text-gray-700">collecting…</span>
          </div>
        )}
      </div>
      {hasSourceData && (
        <>
          <div>
            <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-1.5">Job Sources</div>
            {projects.length > 0 ? (
              <div className="flex w-full h-1.5 rounded-full overflow-hidden gap-px">
                {projects.map(([proj, count]) => (
                  <div key={proj} className={PROJECT_COLORS[proj] ?? "bg-gray-500"}
                    style={{ width: `${(count / total) * 100}%` }} title={`${proj}: ${count}`} />
                ))}
              </div>
            ) : (
              <div className="h-1.5 w-full rounded-full bg-gray-800" />
            )}
            {/* Reserve ~2 legend rows so cards stay even whether or not a pool has job sources. */}
            <div className="flex flex-wrap gap-x-2.5 gap-y-1 mt-1.5 min-h-[2rem] content-start">
              {projects.length > 0 ? (
                projects.map(([proj, count]) => (
                  <span key={proj} className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${PROJECT_COLORS[proj] ?? "bg-gray-500"}`} />
                    <span className={`text-[10px] ${PROJECT_TEXT[proj] ?? "text-gray-400"}`}>{proj}</span>
                    <span className="text-[10px] text-gray-600 tabular-nums">{Math.round((count / total) * 100)}%</span>
                  </span>
                ))
              ) : (
                <span className="text-[10px] text-gray-700">No running tasks</span>
              )}
            </div>
          </div>
          <div>
            <button type="button" onClick={() => setShowSubmitters(s => !s)}
              className="flex items-center gap-1.5 w-full text-[10px] text-gray-600 hover:text-gray-400 uppercase tracking-wider transition-colors">
              Top Submitters
              {submitterCount > 0 && <span className="normal-case tracking-normal text-gray-700">· {submitterCount}</span>}
              <ChevronDown size={12} className={`ml-auto transition-transform ${showSubmitters ? "rotate-180" : ""}`} />
            </button>
            {showSubmitters && (
              <div className="space-y-1 mt-2">
                {submitterCount === 0 ? (
                  <div className="text-[10px] text-gray-700">No submitters in sample</div>
                ) : submitters.map(([user, count], i) => (
                  <div key={user} className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-700 tabular-nums w-3">{i + 1}</span>
                    <span className="text-[10px] font-mono text-gray-400 truncate flex-1" title={user}>{user.replace(/@.*$/, "")}</span>
                    <span className="text-[10px] text-gray-600 tabular-nums">{Math.round((count / total) * 100)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The shared "pinned pool" card — pending/running headline plus the 24h pending
 *  trend, job-source mix, and top submitters. Used on the Overview and Platforms
 *  pages so the two stay identical. The draggable wrapper lives in each caller. */
export function MonitoredPoolCard({ name, pending, running, capacity, series, sources }: {
  name: string;
  pending: number | null;
  running: number | null;
  capacity: number | null;
  series?: PoolSeries;
  sources?: PoolSources | null;
}) {
  const hasLoad = pending !== null || running !== null || capacity !== null;
  const grad = { backgroundImage: FF_GRADIENT } as const;
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 hover:border-gray-700 transition-all">
      <div className="text-xs font-mono text-gray-300 truncate pr-5" title={name}>{name}</div>
      {hasLoad ? (
        <div className="flex items-end gap-5 mt-3">
          <div>
            <div className="text-2xl font-bold tabular-nums bg-clip-text text-transparent leading-none" style={grad}>{(pending ?? 0).toLocaleString()}</div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">pending</div>
          </div>
          <div>
            <div className="text-lg font-bold text-gray-200 tabular-nums leading-none">{running ?? 0}<span className="text-xs text-gray-600">/{capacity ?? 0}</span></div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">running</div>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-gray-600 mt-3">No load sample yet.</div>
      )}
      <MonitoredPoolExtras series={series} sources={sources} />
    </div>
  );
}
