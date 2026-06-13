import { useEffect, useState } from "react";
import type { Worker } from "../api";
import { api } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { usePoll } from "../lib/useLive";
import { fleetCounts, inFleetMap } from "../lib/health";
import { FleetHeatmap, HeatmapLegend } from "../components/FleetHeatmap";

const PLATFORMS = [
  { key: "",        label: "All" },
  { key: "osx",     label: "macOS" },
  { key: "linux",   label: "Linux" },
  { key: "win",     label: "Windows" },
];

export function Heatmap() {
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

  if (error) return <div className="p-8 text-red-400 text-sm">{error}</div>;

  const filtered = platform
    ? workers.filter(w => (w.worker_pool || "").includes(platform))
    : workers;
  const counts = fleetCounts(filtered);

  return (
    <div className="p-8 space-y-6 max-w-[1400px]">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <span className="w-1 h-9 rounded-full flex-shrink-0" style={{ backgroundImage: FF_GRADIENT }} />
          <div>
            <h1 className="text-2xl font-light text-white tracking-tight">Fleet Map</h1>
            <p className="text-gray-500 text-sm mt-0.5">{filtered.length.toLocaleString()} workers · one cell each · worst pools first</p>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-0.5">
          {PLATFORMS.map(({ key, label }) => (
            <button key={key} onClick={() => setPlatform(key)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                platform === key ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
              }`}>
              {label}
            </button>
          ))}
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
    </div>
  );
}
