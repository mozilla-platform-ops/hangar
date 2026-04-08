import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { api } from "../api";
import type { ConsolidationData } from "../api";
import { Badge } from "../components/Badge";

function GenCard({
  title, data, color,
}: {
  title: string;
  data: ConsolidationData["r8"] | ConsolidationData["m4"];
  color: string;
}) {
  const stateColorMap: Record<string, "green" | "blue" | "purple" | "red" | "yellow" | "gray"> = {
    production: "green", staging: "blue", loaner: "purple",
    defective: "red", spare: "yellow",
  };
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-white">{title}</h3>
        <span className={`text-3xl font-bold ${color}`}>{data.total}</span>
      </div>

      <div className="space-y-1.5">
        {Object.entries(data.by_state).sort((a, b) => b[1] - a[1]).map(([state, count]) => (
          <div key={state} className="flex items-center justify-between">
            <Badge label={state} variant={stateColorMap[state] || "gray"} />
            <span className="text-sm font-medium text-white">{count}</span>
          </div>
        ))}
      </div>

      {data.inactive_30d_count > 0 && (
        <div className="rounded-lg bg-orange-950/40 border border-orange-800/40 p-3">
          <div className="text-xs text-orange-300 font-medium">{data.inactive_30d_count} inactive 30+ days</div>
          {data.inactive_30d_sample.slice(0, 3).map(h => (
            <div key={h} className="text-xs text-orange-400/70 font-mono mt-0.5">{h.split(".")[0]}</div>
          ))}
          {data.inactive_30d_sample.length > 3 && (
            <div className="text-xs text-orange-400/50 mt-0.5">+ {data.inactive_30d_count - 3} more</div>
          )}
        </div>
      )}

      <div>
        <div className="text-xs text-gray-500 mb-2 uppercase tracking-wide">Top Pools</div>
        <div className="space-y-1">
          {Object.entries(data.by_pool).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([pool, count]) => (
            <div key={pool} className="flex items-center gap-2">
              <div className="flex-1 bg-gray-800 rounded-full h-1.5">
                <div
                  className="h-1.5 rounded-full"
                  style={{ width: `${Math.min(100, (count / data.total) * 100)}%`, background: color === "text-indigo-400" ? "#6366f1" : "#10b981" }}
                />
              </div>
              <span className="text-xs text-gray-400 w-48 truncate">{pool}</span>
              <span className="text-xs text-white w-6 text-right">{count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Consolidation() {
  const [data, setData] = useState<ConsolidationData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.fleet.consolidation().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="p-8 text-red-400">{error}</div>;
  if (!data) return <div className="p-8 text-gray-400">Loading…</div>;

  const comparisonData = [
    { name: "Production", r8: data.analysis.r8_production_count, m4: data.analysis.m4_production_count },
    { name: "Total", r8: data.r8.total, m4: data.m4.total },
    { name: "Inactive 30d", r8: data.r8.inactive_30d_count, m4: data.m4.inactive_30d_count },
  ];

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Consolidation Analysis</h1>
        <p className="text-gray-400 text-sm mt-1">r8 Intel vs m4 Apple Silicon fleet comparison</p>
      </div>

      {/* Key numbers */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-center">
          <div className="text-3xl font-bold text-indigo-400">{data.r8.total}</div>
          <div className="text-sm text-gray-400 mt-1">r8 workers</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-center">
          <div className="text-3xl font-bold text-emerald-400">{data.m4.total}</div>
          <div className="text-sm text-gray-400 mt-1">m4 workers</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-center">
          <div className="text-3xl font-bold text-yellow-400">{data.analysis.r8_safe_to_retire_estimate}</div>
          <div className="text-sm text-gray-400 mt-1">r8 retire candidates</div>
          <div className="text-xs text-gray-500 mt-0.5">(defective + spare)</div>
        </div>
      </div>

      {/* Side-by-side comparison chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-4">r8 vs m4 Comparison</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={comparisonData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#9ca3af" }} />
            <YAxis tick={{ fontSize: 11, fill: "#9ca3af" }} />
            <Tooltip contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 8 }} />
            <Legend formatter={val => <span className="text-xs text-gray-400">{val}</span>} />
            <Bar dataKey="r8" name="r8 (Intel)" fill="#6366f1" radius={[4, 4, 0, 0]} />
            <Bar dataKey="m4" name="m4 (ARM)" fill="#10b981" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Gen cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <GenCard title="r8 (Intel)" data={data.r8} color="text-indigo-400" />
        <GenCard title="m4 (Apple Silicon)" data={data.m4} color="text-emerald-400" />
      </div>

      {/* Retirement candidates */}
      {data.retirement_candidate_count > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">
            Retirement Candidates ({data.retirement_candidate_count})
          </h3>
          <p className="text-xs text-gray-500 mb-4">r8 workers that are defective, spare, or inactive &gt;30 days</p>
          <div className="flex flex-wrap gap-2">
            {data.retirement_candidates.map(h => (
              <span key={h} className="text-xs font-mono bg-gray-800 text-gray-300 px-2 py-1 rounded">
                {h.split(".")[0]}
              </span>
            ))}
            {data.retirement_candidate_count > 50 && (
              <span className="text-xs text-gray-500 px-2 py-1">+ {data.retirement_candidate_count - 50} more</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
