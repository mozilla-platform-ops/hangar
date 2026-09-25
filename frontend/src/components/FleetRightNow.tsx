import { useEffect, useRef, useState } from "react";
import { api, type RightNow as RightNowData, type RightNowDot, type RightNowPlatform, type RightNowProject } from "../api";
import { AnimatedNumber } from "./AnimatedNumber";
import { HoverCard } from "./HoverCard";
import { FF_GRADIENT } from "../lib/brand";
import { useHover } from "../lib/useHover";
import { usePoll } from "../lib/useLive";

// Project palette, validated (dataviz checker, dark card surface) in exactly this order.
const PROJECT_COLOR: Record<RightNowProject, string> = {
  autoland: "#0e9ac4",
  try: "#8b5cf6",
  release: "#c08510",
  central: "#d6409f",
  thunderbird: "#2f9e63",
};
const OTHER_WORK = "#9ca3af"; // running, but not one of the five projects
const IDLE = "#374151";

const PLATFORM_LABEL: Record<RightNowPlatform, string> = {
  mac: "macOS", linux: "Linux", windows: "Windows", android: "Android",
};
const PLATFORM_ORDER: RightNowPlatform[] = ["mac", "linux", "windows", "android"];

function dotColor(d: RightNowDot, order: RightNowProject[]): string {
  if (d[1] !== "r") return IDLE;
  return d[2] >= 0 ? PROJECT_COLOR[order[d[2]]] : OTHER_WORK;
}

/** Signature per machine, so a poll can tell which ones just picked up new work. */
function dotSignatures(data: RightNowData): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of PLATFORM_ORDER) for (const d of data.dots[p]) m.set(d[0], `${d[1]}${d[2]}`);
  return m;
}

function Constellation({ data, flips }: { data: RightNowData; flips: Set<string> }) {
  const { hover, bind } = useHover();
  const order = data.projects.order;

  const clusters = PLATFORM_ORDER.map(p => {
    const dots: RightNowDot[] =
      p === "android"
        ? Array.from({ length: data.android_dots.total }, (_, i) =>
            [`device ${i + 1}`, i < data.android_dots.running ? "r" : "i", -1, null] as RightNowDot)
        : data.dots[p];
    return { p, dots };
  }).filter(c => c.dots.length > 0);

  const n = data.now;
  const pct = n.machines ? Math.round((n.running / n.machines) * 100) : 0;
  const running = data.projects.running;
  const totalRunning = Object.values(running).reduce((s, v) => s + v, 0) || 1;
  const topProject = order.reduce((a, b) => (running[b] > running[a] ? b : a), order[0]);

  return (
    <div className="card p-6 relative overflow-hidden">
      <div className="absolute top-0 inset-x-0 h-0.5 opacity-80" style={{ backgroundImage: FF_GRADIENT }} />
      <div className="flex flex-col xl:flex-row gap-8">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-gray-500 uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Right now
          </div>
          <p className="text-2xl md:text-3xl font-light text-white leading-snug mt-2 max-w-3xl">
            <span className="font-semibold bg-clip-text text-transparent" style={{ backgroundImage: FF_GRADIENT }}>
              <AnimatedNumber value={n.running} format={v => Math.round(v).toLocaleString()} />
            </span>{" "}
            of {n.machines.toLocaleString()} machines are building and testing Firefox
            <span className="text-gray-500"> ({pct}%)</span>, with{" "}
            <span className="font-semibold text-white"><AnimatedNumber value={n.pending} format={v => Math.round(v).toLocaleString()} /></span>{" "}
            tasks waiting in line.
          </p>

          <div className="mt-6 flex flex-wrap gap-x-8 gap-y-6">
            {clusters.map(({ p, dots }) => {
              const bp = n.by_platform[p];
              return (
                <div key={p} className="min-w-0" style={{ flex: `${Math.max(dots.length, 60)} 1 0`, minWidth: 140 }}>
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="text-xs font-medium text-gray-200">{PLATFORM_LABEL[p]}</span>
                    <span className="text-[10px] text-gray-500 tabular-nums">
                      {bp.running} busy of {dots.length}
                      {bp.pending > 0 && <> · {bp.pending.toLocaleString()} waiting</>}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-[3px]">
                    {dots.map(d => {
                      const color = dotColor(d, order);
                      const lit = d[1] === "r";
                      const proj = d[2] >= 0 ? order[d[2]] : null;
                      return (
                        <span
                          key={d[0]}
                          className={`hm-cell block w-[9px] h-[9px] rounded-full ${flips.has(d[0]) ? "dot-flip" : ""}`}
                          style={{
                            backgroundColor: d[1] === "o" ? "transparent" : color,
                            boxShadow: lit ? `0 0 6px ${color}99` : d[1] === "o" ? `inset 0 0 0 1px ${IDLE}` : undefined,
                          }}
                          {...bind(
                            <>
                              <div className="font-mono text-white">{d[0]}</div>
                              {d[3] && <div className="text-gray-500 font-mono">{d[3]}</div>}
                              <div className="flex items-center gap-2 mt-1 text-gray-300">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                                {lit ? (proj ? `Running ${data.projects.labels[proj]} work` : "Running a task") : d[1] === "i" ? "Idle, ready for work" : "Offline or parked"}
                              </div>
                            </>,
                          )}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* whose work it is */}
        <div className="xl:w-72 flex-shrink-0">
          <div className="text-[11px] text-gray-500 uppercase tracking-wider">Whose work</div>
          <p className="text-sm text-gray-300 mt-2 leading-relaxed">
            <span className="text-white font-medium">{data.projects.labels[topProject]}</span> is the biggest customer right now, with{" "}
            {Math.round((running[topProject] / totalRunning) * 100)}% of running tasks.
          </p>
          <div className="mt-4 space-y-2.5">
            {[...order, "other" as const].map(k => {
              const v = running[k];
              const color = k === "other" ? OTHER_WORK : PROJECT_COLOR[k];
              const label = k === "other" ? "Everything else" : data.projects.labels[k];
              return (
                <div key={k}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2 text-gray-300">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />{label}
                    </span>
                    <span className="tabular-nums text-gray-200"><AnimatedNumber value={v} /></span>
                  </div>
                  <div className="h-1 mt-1 rounded-full bg-gray-800/70 overflow-hidden">
                    <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${(v / totalRunning) * 100}%`, backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-5 pt-4 border-t border-gray-800/60 text-[11px] text-gray-500">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: IDLE }} />idle</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ boxShadow: `inset 0 0 0 1px ${IDLE}` }} />offline</span>
          </div>
          <p className="text-[10px] text-gray-600 mt-3 leading-relaxed">
            Project comes from each running task's Taskcluster tags. Android devices aren't tracked per device, so they show as other work.
          </p>
        </div>
      </div>
      <HoverCard hover={hover} />
    </div>
  );
}


/** The fleet right now: every machine as a dot, lit by the Firefox project whose task
 *  it is running. Fetches on its own (one cached request, polled with the page). */
export function FleetRightNow() {
  const [data, setData] = useState<RightNowData | null>(null);
  const [flips, setFlips] = useState<Set<string>>(() => new Set());
  const sigs = useRef<Map<string, string> | null>(null);

  // Machines whose work changed since the last poll flare once, so the room sees work
  // land as it happens. Diffed here, in the fetch callback, not during render.
  const load = () => api.rightNow.get().then(d => {
    const next = dotSignatures(d);
    const prev = sigs.current;
    const flipped = new Set<string>();
    if (prev) for (const [host, sig] of next) if (sig[0] === "r" && prev.get(host) !== sig) flipped.add(host);
    sigs.current = next;
    setData(d);
    setFlips(flipped);
  }).catch(() => {});

  useEffect(() => { load(); }, []);
  usePoll(load, 60_000);

  if (!data) return null;
  return <Constellation data={data} flips={flips} />;
}
