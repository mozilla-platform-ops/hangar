import { useEffect, useState } from "react";
import { TrendingUp, Zap } from "lucide-react";
import { api } from "../api";
import type { ShowcaseData } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { usePoll } from "../lib/useLive";

// ── Curated milestones ────────────────────────────────────────────────────────
// EDIT THESE: facts drawn from RelOps handoffs, NOT auto-derived from fleet data.
// Update as the migration progresses. Everything else on the showcase is live.
const TEAM = {
  macosSuitesMigrated: 12,        // of the functional macOS test suites moved Intel → M4
  macosSuitesTotal: 13,
  macosSuiteRemaining: "gtest",
  m4MedianSpeedup: 38,            // % median faster on Apple Silicon (106 of 122 suites)
};

const grad = { backgroundImage: FF_GRADIENT } as const;

/** macOS Intel → Apple Silicon migration story — lives on the Pool Health macOS page. */
export function MacMigrationCard() {
  const [data, setData] = useState<ShowcaseData | null>(null);

  useEffect(() => {
    api.fleet.showcase().then(setData).catch(() => {});
  }, []);
  usePoll(() => api.fleet.showcase().then(setData).catch(() => {}), 120_000);

  if (!data) return null;

  const m = data.migration;
  const suitePct = Math.round((TEAM.macosSuitesMigrated / TEAM.macosSuitesTotal) * 100);
  const axes = [
    { key: "m4", label: "M4 bare-metal", workers: m.m4.workers, accent: "#9059FF" },
    { key: "m4_vm", label: "M4 VMs", workers: m.m4_vm.workers, accent: "#FF1AD9" },
    { key: "intel", label: "Intel (retiring)", workers: m.intel.workers, accent: "#6b7280" },
    { key: "catalina", label: "Catalina (deprecating)", workers: m.catalina.workers, accent: "#4b5563" },
  ];

  return (
    <div className="card p-5 relative overflow-hidden">
      <div className="absolute top-0 inset-x-0 h-0.5 opacity-80" style={grad} />
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp size={14} className="text-brand-400" />
        <h3 className="text-sm font-semibold text-gray-200 tracking-tight">Migration · Intel → Apple Silicon</h3>
      </div>

      {/* Headline: share of recent macOS test load on modern hardware */}
      <div className="flex items-end gap-3">
        <span className="text-4xl font-bold tabular-nums bg-clip-text text-transparent leading-none" style={grad}>{m.modern_load_pct}%</span>
        <span className="text-xs text-gray-400 mb-1">of recent macOS test load now on Apple Silicon</span>
      </div>
      <div className="mt-3 flex w-full h-2.5 rounded-full overflow-hidden gap-px bg-gray-800">
        <div style={{ width: `${m.modern_load_pct}%`, backgroundImage: FF_GRADIENT }} title={`Apple Silicon: ${m.modern_load_pct}%`} />
        <div style={{ width: `${m.intel_load_pct}%`, backgroundColor: "#4b5563" }} title={`Intel: ${m.intel_load_pct}%`} />
      </div>
      <div className="text-[10px] text-gray-600 mt-1.5">by worker-hours over the last {Math.round(data.scale.window_hours)}h · Intel {m.intel_load_pct}%</div>

      {/* Worker distribution across the migration axis */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {axes.map(a => (
          <div key={a.key} className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: a.accent }} />
              <span className="text-lg font-bold text-gray-100 tabular-nums leading-none">{a.workers}</span>
            </div>
            <div className="text-[10px] text-gray-500 mt-1 truncate" title={a.label}>{a.label}</div>
          </div>
        ))}
      </div>

      {/* Curated milestones — clearly marked with ★ */}
      <div className="mt-4 pt-4 border-t border-gray-800/60 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-200 tabular-nums">{TEAM.macosSuitesMigrated}/{TEAM.macosSuitesTotal}</span>
            <div className="w-24 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${suitePct}%`, backgroundImage: FF_GRADIENT }} />
            </div>
          </div>
          <div className="text-[10px] text-gray-600 mt-1">★ functional suites migrated · {TEAM.macosSuiteRemaining} remaining</div>
        </div>
        <div className="flex items-center gap-1.5 text-emerald-400">
          <Zap size={13} />
          <span className="text-sm font-semibold tabular-nums">+{TEAM.m4MedianSpeedup}%</span>
          <span className="text-[10px] text-gray-600">★ median faster on M4</span>
        </div>
      </div>
      <div className="text-[10px] text-gray-700 mt-3">Worker counts &amp; load share are live · ★ milestones curated from RelOps handoffs</div>
    </div>
  );
}
