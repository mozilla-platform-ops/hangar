import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Worker } from "../api";
import { workerHealth, groupByPool, type HealthStatus, type HealthCounts } from "../lib/health";

const CELL_COLOR: Record<string, string> = {
  healthy:  "#34d399", // emerald-400
  degraded: "#fbbf24", // amber-400
  critical: "#f87171", // red-400
};
const SPARE_COLOR = "#374151"; // gray-700 — not in production

function cellColor(status: HealthStatus): string {
  return status ? CELL_COLOR[status] : SPARE_COLOR;
}

function shortHost(w: Worker): string {
  return w.worker_id || w.hostname.split(".")[0];
}

/** Dot-matrix view of the whole fleet — one cell per worker, colored by health,
 *  grouped into pool rows. Reads the shape of 845 machines at a glance. */
export function FleetHeatmap({ workers, cell = 13, gap = 3, onpick, interactive = true }: {
  workers: Worker[];
  cell?: number;
  gap?: number;
  onpick?: (w: Worker) => void;
  interactive?: boolean;
}) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<{ w: Worker; x: number; y: number } | null>(null);
  const groups = useMemo(() => groupByPool(workers), [workers]);

  const pick = onpick ?? ((w: Worker) => navigate(`/workers/${w.hostname}`));

  return (
    <div className="relative">
      <div className="space-y-3">
        {groups.map(g => (
          <div key={g.name} className="flex items-start gap-4">
            <div className="w-52 flex-shrink-0 pt-0.5">
              <div className="text-xs font-mono text-gray-300 truncate" title={g.name}>{g.name}</div>
              <div className="text-[10px] text-gray-600 tabular-nums">
                {g.workers.length}
                {g.counts.critical > 0 && <span className="text-red-400"> · {g.counts.critical} crit</span>}
                {g.counts.degraded > 0 && <span className="text-amber-400"> · {g.counts.degraded} deg</span>}
              </div>
            </div>
            <div className="flex flex-wrap" style={{ gap }}>
              {g.workers.map(w => {
                const status = workerHealth(w);
                return (
                  <div
                    key={w.hostname}
                    className={interactive ? "hm-cell cursor-pointer rounded-[2px]" : "rounded-[2px]"}
                    style={{ width: cell, height: cell, backgroundColor: cellColor(status) }}
                    onMouseEnter={interactive ? e => setHover({ w, x: e.clientX, y: e.clientY }) : undefined}
                    onMouseMove={interactive ? e => setHover({ w, x: e.clientX, y: e.clientY }) : undefined}
                    onMouseLeave={interactive ? () => setHover(null) : undefined}
                    onClick={interactive ? () => pick(w) : undefined}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {hover && (
        <div
          className="fixed z-50 pointer-events-none card px-3 py-2 text-xs shadow-xl"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 220), top: hover.y + 14 }}
        >
          <div className="font-mono text-white">{shortHost(hover.w)}</div>
          <div className="text-gray-400 mt-0.5">{hover.w.worker_pool}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cellColor(workerHealth(hover.w)) }} />
            <span className="text-gray-300">{hover.w.state}{hover.w.tc.quarantined ? " · quarantined" : ""}</span>
          </div>
          {hover.w.tc.last_active && (
            <div className="text-gray-600 mt-0.5">last active {timeAgo(hover.w.tc.last_active)}</div>
          )}
        </div>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const hrs = Math.round((Date.now() - new Date(iso).getTime()) / 36e5);
  if (hrs < 1) return "<1h ago";
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Shared legend swatches for the heatmap. */
export function HeatmapLegend({ counts }: { counts?: HealthCounts }) {
  const items = [
    { label: "Healthy", color: CELL_COLOR.healthy, n: counts?.healthy },
    { label: "Degraded", color: CELL_COLOR.degraded, n: counts?.degraded },
    { label: "Critical", color: CELL_COLOR.critical, n: counts?.critical },
    { label: "Not in prod", color: SPARE_COLOR, n: counts?.other },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {items.map(it => (
        <div key={it.label} className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-[2px]" style={{ backgroundColor: it.color }} />
          <span className="text-xs text-gray-400">{it.label}</span>
          {it.n !== undefined && <span className="text-xs font-mono text-gray-300 tabular-nums">{it.n.toLocaleString()}</span>}
        </div>
      ))}
    </div>
  );
}
