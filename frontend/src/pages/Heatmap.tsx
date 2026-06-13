import { useEffect, useMemo, useState } from "react";
import type { Worker } from "../api";
import { api } from "../api";
import { usePoll } from "../lib/useLive";
import { fleetCounts, inFleetMap } from "../lib/health";
import { FleetHeatmap, HeatmapLegend } from "../components/FleetHeatmap";

// Filter on the worker's server-derived platform field (mac/linux/windows) —
// robust where pool-name substrings aren't (e.g. Windows nuc* boxes).
const PLATFORMS = [
  { key: "",        label: "All" },
  { key: "mac",     label: "macOS" },
  { key: "linux",   label: "Linux" },
  { key: "windows", label: "Windows" },
];

/** Body-only fleet heatmap view — rendered inside the Fleet page (Map tab). */
export function FleetMapView() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [error, setError] = useState("");
  const [platform, setPlatform] = useState("");

  const load = (silent = false) => {
    api.workers.list({ limit: 2000 })
      .then(d => setWorkers(d.workers.filter(inFleetMap)))
      .catch(e => { if (!silent) setError(e.message); });
  };
  useEffect(() => load(), []);
  usePoll(() => load(true), 60_000);

  const platformCount = useMemo(() => {
    const c: Record<string, number> = { "": workers.length };
    for (const w of workers) {
      const p = w.platform || "other";
      c[p] = (c[p] || 0) + 1;
    }
    return c;
  }, [workers]);

  if (error) return <div className="text-red-400 text-sm">{error}</div>;

  const filtered = platform
    ? workers.filter(w => w.platform === platform)
    : workers;
  const counts = fleetCounts(filtered);

  return (
    <>
      {/* Controls row: platform filter + count */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-gray-500 text-sm">{filtered.length.toLocaleString()} workers · one cell each · worst pools first</p>
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-0.5">
          {PLATFORMS.map(({ key, label }) => {
            const n = platformCount[key] ?? 0;
            return (
              <button key={key} onClick={() => setPlatform(key)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${
                  platform === key ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
                }`}>
                {label}
                <span className={`tabular-nums ${platform === key ? "text-gray-300" : "text-gray-600"}`}>{n.toLocaleString()}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card p-4">
        <HeatmapLegend counts={counts} />
      </div>

      <div className="card p-5 overflow-x-auto">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-gray-600 text-sm flex items-center justify-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" /> Loading fleet…
          </div>
        ) : (
          <FleetHeatmap workers={filtered} />
        )}
      </div>
    </>
  );
}
