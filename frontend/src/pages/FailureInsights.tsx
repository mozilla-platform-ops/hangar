import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Cpu, FlaskConical } from "lucide-react";
import { api, type FailureInsights as FailureInsightsData } from "../api";
import { usePoll } from "../lib/useLive";

function timeAgo(iso: string | null, now = Date.now()) {
  if (!iso) return "never";
  const diff = now - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
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

const FAILURE_PLATFORMS = [
  { key: "",        label: "All" },
  { key: "mac",     label: "macOS" },
  { key: "linux",   label: "Linux" },
  { key: "windows", label: "Windows" },
];

/** Failure Insights — top machine + test failures over the last 7 days, filterable by platform.
 *  Split out of the Overview into its own page (nav: after Alerts). */
export function FailureInsights() {
  const [failures, setFailures] = useState<FailureInsightsData | null>(null);
  const [failurePlatform, setFailurePlatform] = useState("");

  useEffect(() => {
    setFailures(null);
    api.fleet.failures(7, failurePlatform || undefined).then(setFailures).catch(() => {});
  }, [failurePlatform]);

  // Keep it live while the tab is visible.
  usePoll(() => {
    api.fleet.failures(7, failurePlatform || undefined).then(setFailures).catch(() => {});
  }, 60_000);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-light text-white tracking-tight">Failure Insights</h1>
          <p className="text-gray-500 text-sm mt-0.5">top machine &amp; test failures · last 7 days</p>
        </div>
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-0.5">
          {FAILURE_PLATFORMS.map(({ key, label }) => (
            <button key={key} onClick={() => setFailurePlatform(key)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                failurePlatform === key ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
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
                      <Link to={`/workers/${f.short_hostname}`} className="text-xs font-mono text-gray-300 hover:text-white transition-colors">{f.short_hostname}</Link>
                    </td>
                    <td className="py-2"><span className="text-[10px] font-mono text-gray-600">{shortPool(f.worker_pool)}</span></td>
                    <td className="py-2 text-right"><span className="text-xs font-bold text-red-400 tabular-nums">{f.count}</span></td>
                    <td className="py-2 pl-4 text-right"><span className="text-[10px] text-gray-600 whitespace-nowrap">{timeAgo(f.last_at)}</span></td>
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
                    <td className="py-2 pl-2 max-w-[240px]"><span className="text-xs font-mono text-gray-300 break-all">{shortTaskName(f.task_name)}</span></td>
                    <td className="py-2 text-right"><span className="text-xs font-bold text-orange-400 tabular-nums">{f.count}</span></td>
                    <td className="py-2 pl-4 text-right"><span className="text-[10px] text-gray-600 whitespace-nowrap">{timeAgo(f.last_at)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
