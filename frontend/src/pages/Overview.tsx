import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { Cpu, FlaskConical, ArrowUpRight, Gauge, Pin, Plus, X, Check, GripVertical, Pencil, Rocket, CalendarClock, ExternalLink,
  Sun, Moon, Cloud, CloudSun, CloudMoon, CloudRain, CloudDrizzle, CloudSnow, CloudLightning, CloudFog, Search, LocateFixed, LoaderCircle } from "lucide-react";
import { api } from "../api";
import type { FleetSummary, FailureInsights, LoadHistory, ReleaseSchedule, WeatherNow, WeatherPref, GeocodeResult, ShowcaseData } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { usePoll, useNow } from "../lib/useLive";

const YARDSTICK_BASE = "https://yardstick.mozilla.org/d/ieg6Sho5/workers?orgId=1&from=now-2d&to=now&timezone=browser&refresh=5m";
const yardstickAll = `${YARDSTICK_BASE}&var-provisioner=$__all&var-workerType=$__all`;
const yardstickPool = (pool: string) =>
  `${YARDSTICK_BASE}&var-provisioner=$__all&var-workerType=${encodeURIComponent(pool)}`;

// Mapped across the Firefox gradient (orange → magenta → violet) so the meter echoes the
// health ring / sparkline accents and leaves emerald free for "healthy"/production.
const PLATFORM_COLORS = { macOS: "#FF9400", Linux: "#FF1AD9", Windows: "#9059FF" } as const;

function timeAgo(iso: string | null, now = Date.now()) {
  if (!iso) return "never";
  const diff = now - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

// Parse "2026-06-16" as a *local* date (avoids the UTC-midnight off-by-one of new Date(iso)).
function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(iso: string | null): string {
  if (!iso) return "TBD";
  const d = parseDate(iso);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}
function daysUntil(iso: string | null): string {
  if (!iso) return "";
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((parseDate(iso).getTime() - start.getTime()) / 86400000);
  if (days < 0) return "shipped";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
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

/** Smooth area sparkline with the Firefox gradient. Crisp stroke at any width. */
function Sparkline({ points }: { points: number[] }) {
  const W = 560, H = 60, pad = 4;
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const dx = W / (points.length - 1);
  const xy = points.map((v, i) => [i * dx, H - pad - ((v - min) / range) * (H - pad * 2)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-16 spark-svg">
      <defs>
        <linearGradient id="sparkStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FF9400" />
          <stop offset="50%" stopColor="#FF1AD9" />
          <stop offset="100%" stopColor="#9059FF" />
        </linearGradient>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FF1AD9" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#FF1AD9" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sparkFill)" />
      <path d={line} fill="none" stroke="url(#sparkStroke)" strokeWidth={2} vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={3.5} fill="#FF1AD9" vectorEffect="non-scaling-stroke" className="spark-dot" />
    </svg>
  );
}

/** Fleet-health ring with a gradient arc; children render in the center. */
function HealthRing({ pct, children }: { pct: number; children: React.ReactNode }) {
  const r = 54, c = 2 * Math.PI * r, dash = (Math.max(0, Math.min(100, pct)) / 100) * c;
  return (
    <div className="relative w-32 h-32 flex-shrink-0">
      <svg viewBox="0 0 128 128" className="w-full h-full -rotate-90">
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FF9400" />
            <stop offset="50%" stopColor="#FF1AD9" />
            <stop offset="100%" stopColor="#9059FF" />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r={r} fill="none" stroke="#1f2937" strokeWidth="8" />
        <circle cx="64" cy="64" r={r} fill="none" stroke="url(#ringGrad)" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`} style={{ transition: "stroke-dasharray 0.6s ease" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

// ── Monitored pools (user-pinned; follows the IAP-authenticated user across devices) ──
const MONITOR_KEY = "hangar.monitoredPools"; // legacy per-browser store, migrated once into the backend
const MONITOR_MAX = 8;

// Read any pins from the old localStorage store, for one-time migration to the per-user backend.
function legacyLocalPins(): string[] {
  try {
    const raw = localStorage.getItem(MONITOR_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p) && p.every((x: unknown) => typeof x === "string")) return p.slice(0, MONITOR_MAX);
    }
  } catch { /* ignore */ }
  return [];
}
function reorderList<T>(list: T[], from: number, to: number): T[] {
  const n = [...list];
  const [m] = n.splice(from, 1);
  n.splice(to, 0, m);
  return n;
}

function MonitoredPools({ load }: { load: LoadHistory | null }) {
  const [monitored, setMonitored] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // Load this user's pins from the backend; migrate legacy localStorage pins on first run.
  useEffect(() => {
    let cancelled = false;
    api.me.monitoredPools().then(async d => {
      let pools = d.pools;
      if (pools.length === 0) {
        const legacy = legacyLocalPins();
        if (legacy.length > 0) {
          try { pools = (await api.me.setMonitoredPools(legacy)).pools; } catch { pools = legacy; }
          try { localStorage.removeItem(MONITOR_KEY); } catch { /* ignore */ }
        }
      }
      if (!cancelled) setMonitored(pools);
    }).catch(() => { /* leave empty on error */ });
    return () => { cancelled = true; };
  }, []);

  const byName = new Map((load?.pools ?? []).map(p => [p.pool, p] as const));
  const available = (load?.pools ?? []).map(p => p.pool);
  const persist = (next: string[]) => { setMonitored(next); api.me.setMonitoredPools(next).catch(() => {}); };
  const toggle = (name: string) =>
    persist(monitored.includes(name)
      ? monitored.filter(n => n !== name)
      : monitored.length >= MONITOR_MAX ? monitored : [...monitored, name]);
  const onDrop = (to: number) => {
    if (dragIdx !== null && dragIdx !== to) persist(reorderList(monitored, dragIdx, to));
    setDragIdx(null);
  };
  const grad = { backgroundImage: FF_GRADIENT } as const;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          <Pin size={13} className="text-gray-500" /> Monitored Pools
        </h3>
        {(monitored.length > 0 || editing) && (
          <button onClick={() => setEditing(e => !e)}
            className="text-[11px] text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1">
            {editing ? "Done" : <><Pencil size={11} /> Edit</>}
          </button>
        )}
      </div>

      {editing && (
        <div className="mb-4 space-y-3">
          {monitored.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {monitored.length > 1 && <span className="text-[10px] text-gray-600 self-center mr-0.5">drag to reorder:</span>}
              {monitored.map((name, i) => (
                <span key={name}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => onDrop(i)}
                  onDragEnd={() => setDragIdx(null)}
                  className={`flex items-center gap-1.5 text-xs font-mono bg-brand-900/20 text-brand-200 border border-brand-500/30 rounded-full pl-2 pr-1.5 py-1 cursor-grab active:cursor-grabbing ${dragIdx === i ? "opacity-40" : ""}`}>
                  <GripVertical size={11} className="text-brand-400/50" />
                  {name}
                  <button onClick={() => toggle(name)} className="text-brand-400/70 hover:text-brand-200 transition-colors"><X size={11} /></button>
                </span>
              ))}
            </div>
          )}
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter pools…"
            className="w-full bg-gray-900/60 border border-gray-700/60 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500/50" />
          <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-800/60 divide-y divide-gray-800/40">
            {available.length === 0 ? (
              <div className="px-3 py-4 text-xs text-gray-600">Pool load data is still loading…</div>
            ) : available.filter(n => n.toLowerCase().includes(filter.trim().toLowerCase())).map(name => {
              const sel = monitored.includes(name);
              const disabled = !sel && monitored.length >= MONITOR_MAX;
              return (
                <button key={name} onClick={() => toggle(name)} disabled={disabled}
                  className={`flex items-center gap-2 w-full text-left px-3 py-2 text-xs font-mono transition-colors ${
                    sel ? "bg-brand-900/15 text-brand-200" : disabled ? "text-gray-700 cursor-not-allowed" : "text-gray-300 hover:bg-gray-800/40"
                  }`}>
                  <span className={`flex items-center justify-center w-3.5 h-3.5 rounded border flex-shrink-0 ${sel ? "bg-brand-500 border-brand-500" : "border-gray-600"}`}>
                    {sel && <Check size={10} className="text-white" />}
                  </span>
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {monitored.length === 0 && !editing ? (
        <button onClick={() => setEditing(true)}
          className="w-full flex flex-col items-center justify-center gap-3 py-9 rounded-xl border border-dashed border-gray-700/70 hover:border-brand-500/50 transition-colors">
          <span className="w-11 h-11 rounded-full flex items-center justify-center shadow-lg" style={grad}>
            <Pin size={18} className="text-white" />
          </span>
          <div className="text-center">
            <div className="text-sm font-medium text-white">Pin pools to monitor</div>
            <div className="text-xs text-gray-500 mt-1 max-w-xs">Keep the pools you care about front and center on your dashboard — load updates live.</div>
          </div>
          <span className="text-[11px] font-medium text-brand-300 flex items-center gap-1"><Plus size={12} /> Add pools</span>
        </button>
      ) : monitored.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {monitored.map((name, i) => {
            const p = byName.get(name);
            const cap = p?.capacity ?? 0, running = p?.running ?? 0, pending = p?.pending ?? 0;
            const util = cap > 0 ? Math.round((running / cap) * 100) : 0;
            return (
              <div key={name}
                draggable
                onDragStart={() => setDragIdx(i)}
                onDragOver={e => e.preventDefault()}
                onDrop={() => onDrop(i)}
                onDragEnd={() => setDragIdx(null)}
                className={`group relative rounded-xl border border-gray-800 bg-gray-900/60 p-4 cursor-grab active:cursor-grabbing transition-all hover:border-gray-700 ${dragIdx === i ? "opacity-40" : ""}`}>
                <div className="absolute top-2.5 right-2.5 text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"><GripVertical size={13} /></div>
                <div className="text-xs font-mono text-gray-300 truncate pr-5" title={name}>{name}</div>
                {p ? (
                  <>
                    <div className="flex items-end gap-5 mt-3">
                      <div>
                        <div className="text-2xl font-bold tabular-nums bg-clip-text text-transparent leading-none" style={grad}>{pending.toLocaleString()}</div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">pending</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold text-gray-200 tabular-nums leading-none">{running}<span className="text-xs text-gray-600">/{cap}</span></div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">running</div>
                      </div>
                    </div>
                    <div className="mt-2.5 w-full bg-gray-800 rounded-full h-1 overflow-hidden">
                      <div className="h-1 rounded-full" style={{ width: `${Math.min(util, 100)}%`, backgroundImage: FF_GRADIENT }} />
                    </div>
                  </>
                ) : (
                  <div className="text-[11px] text-gray-600 mt-3">No load sample yet.</div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── Firefox release schedule (product-details + whattrainisitnow) ────────────
function ReleaseScheduleCard() {
  const [sched, setSched] = useState<ReleaseSchedule | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.releases.schedule().then(setSched).catch(() => setFailed(true));
  }, []);

  if (failed) return null; // never block the Overview on this reference data
  const grad = { backgroundImage: FF_GRADIENT } as const;

  if (!sched) {
    return (
      <div className="card p-5">
        <div className="text-xs text-gray-600 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" /> Loading release schedule…
        </div>
      </div>
    );
  }

  const next = sched.next_release;
  // In-flight train milestones plus the release itself, in date order, for the timeline rail.
  const railUpcoming = sched.upcoming.slice(0, 6);

  return (
    <div className="card p-5 relative overflow-hidden">
      <div className="absolute top-0 inset-x-0 h-0.5 opacity-80" style={grad} />
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          <Rocket size={13} className="text-gray-500" /> Firefox Release Schedule
        </h3>
        <a href="https://whattrainisitnow.com/calendar/" target="_blank" rel="noopener noreferrer"
          className="text-[11px] text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1">
          Full calendar <ArrowUpRight size={12} />
        </a>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Next release headline + in-flight milestones */}
        <div className="lg:w-[42%] lg:border-r lg:border-gray-800/60 lg:pr-6">
          <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Next release</div>
          {next ? (
            <a
              href={next.release_notes ?? undefined}
              target="_blank" rel="noopener noreferrer"
              className={`group block ${next.release_notes ? "" : "pointer-events-none"}`}
            >
              <div className="flex items-baseline gap-3">
                <span className="text-4xl font-bold tabular-nums bg-clip-text text-transparent leading-none" style={grad}>
                  {next.version}
                </span>
                <span className="text-sm text-gray-400">{fmtDate(next.date)}</span>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[11px] font-medium text-gray-300">{daysUntil(next.date)}</span>
                {next.release_notes && (
                  <span className="text-[11px] text-brand-400 group-hover:text-brand-300 transition-colors flex items-center gap-1">
                    · release notes <ExternalLink size={10} />
                  </span>
                )}
              </div>
            </a>
          ) : (
            <div className="text-sm text-gray-500">Schedule unavailable</div>
          )}

          {sched.milestones.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-800/60 space-y-2">
              <div className="text-[10px] text-gray-600 uppercase tracking-wider flex items-center gap-1.5">
                <CalendarClock size={11} /> Leading up
              </div>
              {sched.milestones.map(m => (
                <div key={m.key} className="flex items-center justify-between text-xs">
                  <span className="text-gray-400">{m.label}</span>
                  <span className="text-gray-500 tabular-nums">{fmtDate(m.date)} <span className="text-gray-700">· {daysUntil(m.date)}</span></span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Channels + upcoming timeline */}
        <div className="flex-1 space-y-5">
          <div>
            <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Current versions</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {sched.channels.map(c => {
                const inner = (
                  <>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider truncate">{c.label}</div>
                    <div className="text-sm font-mono font-semibold text-gray-200 truncate flex items-center gap-1">
                      {c.version}
                      {c.release_notes && <ExternalLink size={9} className="text-gray-600 group-hover:text-brand-400 transition-colors flex-shrink-0" />}
                    </div>
                  </>
                );
                return c.release_notes ? (
                  <a key={c.channel} href={c.release_notes} target="_blank" rel="noopener noreferrer"
                    className="group rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 hover:border-gray-700 transition-colors">
                    {inner}
                  </a>
                ) : (
                  <div key={c.channel} className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
                    {inner}
                  </div>
                );
              })}
            </div>
          </div>

          {railUpcoming.length > 0 && (
            <div>
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Upcoming releases</div>
              <div className="flex flex-wrap gap-2">
                {railUpcoming.map(u => (
                  <a key={u.version} href={u.release_notes} target="_blank" rel="noopener noreferrer"
                    className="group flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900/60 pl-3 pr-2.5 py-1 hover:border-brand-500/40 transition-colors">
                    <span className="text-xs font-mono font-semibold text-gray-200">{u.version}</span>
                    <span className="text-[11px] text-gray-500 tabular-nums">{fmtDate(u.date)}</span>
                    <ExternalLink size={9} className="text-gray-600 group-hover:text-brand-400 transition-colors" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Weather (opt-in greeting chip) ───────────────────────────────────────────
// WMO weather code → icon + label (https://open-meteo.com/en/docs#weathervariables).
function wmo(code: number | null, isDay: boolean): { Icon: typeof Sun; label: string } {
  const c = code ?? -1;
  if (c === 0) return isDay ? { Icon: Sun, label: "Clear" } : { Icon: Moon, label: "Clear" };
  if (c === 1 || c === 2) return isDay ? { Icon: CloudSun, label: "Partly cloudy" } : { Icon: CloudMoon, label: "Partly cloudy" };
  if (c === 3) return { Icon: Cloud, label: "Overcast" };
  if (c === 45 || c === 48) return { Icon: CloudFog, label: "Fog" };
  if (c >= 51 && c <= 57) return { Icon: CloudDrizzle, label: "Drizzle" };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { Icon: CloudRain, label: "Rain" };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { Icon: CloudSnow, label: "Snow" };
  if (c >= 95) return { Icon: CloudLightning, label: "Thunderstorm" };
  return { Icon: Cloud, label: "" };
}

function placeLabel(r: GeocodeResult): string {
  return [r.name, r.admin1, r.country_code].filter(Boolean).join(", ");
}

const DEFAULT_WEATHER: WeatherPref = { enabled: false, label: "", lat: null, lon: null, unit: "fahrenheit" };

function WeatherChip() {
  const [pref, setPref] = useState<WeatherPref | null>(null);
  const [now, setNow] = useState<WeatherNow | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Load this user's saved preference once (IAP-backed, follows them across devices).
  useEffect(() => {
    api.me.weather().then(d => setPref(d.weather)).catch(() => setPref(DEFAULT_WEATHER));
  }, []);

  // Fetch current conditions whenever an enabled pref with coordinates is present.
  useEffect(() => {
    if (pref?.enabled && pref.lat != null && pref.lon != null) {
      setNow(null);
      api.weather.current(pref.lat, pref.lon, pref.unit).then(setNow).catch(() => setNow(null));
    } else {
      setNow(null);
    }
  }, [pref?.enabled, pref?.lat, pref?.lon, pref?.unit]);

  // Conditions change; refresh them through the day (silently — keep the old reading on error).
  usePoll(() => {
    if (pref?.enabled && pref.lat != null && pref.lon != null) {
      api.weather.current(pref.lat, pref.lon, pref.unit).then(setNow).catch(() => {});
    }
  }, 900_000);

  // Debounced city search.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api.weather.geocode(q).then(d => setResults(d.results)).catch(() => setResults([])).finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // Dismiss the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!pref) return null; // still loading — render nothing to avoid flicker

  const persist = (next: WeatherPref) => { setPref(next); api.me.setWeather(next).catch(() => {}); };
  const pick = (r: GeocodeResult) => {
    persist({ enabled: true, label: placeLabel(r), lat: r.lat, lon: r.lon, unit: pref.unit });
    setQuery(""); setResults([]); setOpen(false);
  };
  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        persist({ enabled: true, label: "Current location",
          lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3), unit: pref.unit });
        setLocating(false); setOpen(false);
      },
      () => setLocating(false),
      { timeout: 8000 },
    );
  };
  const disable = () => { persist({ ...pref, enabled: false }); setOpen(false); };

  const configured = pref.enabled && pref.lat != null && pref.lon != null;
  const { Icon, label } = now ? wmo(now.code, now.is_day) : { Icon: Cloud, label: "" };

  return (
    <div className="relative" ref={popRef}>
      {configured ? (
        <button onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-200 transition-colors"
          title={`${label}${now?.feels_like != null ? ` · feels ${Math.round(now.feels_like)}${now.temp_unit}` : ""} · ${pref.label}`}>
          <Icon size={14} className="text-brand-400" />
          {now ? (
            <span className="tabular-nums font-medium">{Math.round(now.temp ?? 0)}{now.temp_unit}</span>
          ) : (
            <LoaderCircle size={12} className="animate-spin text-gray-600" />
          )}
          <span className="text-gray-600 hidden sm:inline truncate max-w-[120px]">{pref.label}</span>
        </button>
      ) : (
        <button onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1 text-[11px] text-gray-600 hover:text-brand-300 transition-colors">
          <Plus size={11} /> Weather
        </button>
      )}

      {open && (
        <div className="absolute right-0 mt-2 w-72 z-30 card p-3 shadow-xl">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Weather</span>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center rounded-md border border-gray-800 overflow-hidden">
                {(["fahrenheit", "celsius"] as const).map(u => (
                  <button key={u} onClick={() => persist({ ...pref, unit: u })}
                    className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${pref.unit === u ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}>
                    {u === "fahrenheit" ? "°F" : "°C"}
                  </button>
                ))}
              </div>
              <button onClick={() => setOpen(false)} className="text-gray-600 hover:text-gray-300 p-0.5"><X size={13} /></button>
            </div>
          </div>

          <button onClick={useMyLocation} disabled={locating}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-gray-300 hover:bg-gray-800/60 transition-colors mb-2 disabled:opacity-50">
            {locating ? <LoaderCircle size={13} className="animate-spin" /> : <LocateFixed size={13} className="text-brand-400" />}
            Use my location
          </button>

          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search city…" autoFocus
              className="w-full bg-gray-900/60 border border-gray-700/60 rounded-lg pl-7 pr-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500/50" />
          </div>

          {(results.length > 0 || searching) && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-800/60 divide-y divide-gray-800/40">
              {searching && results.length === 0 && <div className="px-3 py-2 text-[11px] text-gray-600">Searching…</div>}
              {results.map((r, i) => (
                <button key={`${r.lat},${r.lon},${i}`} onClick={() => pick(r)}
                  className="block w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800/40 transition-colors truncate">
                  {placeLabel(r)}
                </button>
              ))}
            </div>
          )}

          {configured && (
            <button onClick={disable} className="mt-3 text-[10px] text-gray-600 hover:text-red-400 transition-colors">Turn off weather</button>
          )}
        </div>
      )}
    </div>
  );
}

export function Overview() {
  const [data, setData] = useState<FleetSummary | null>(null);
  const [failures, setFailures] = useState<FailureInsights | null>(null);
  const [load, setLoad] = useState<LoadHistory | null>(null);
  const [scale, setScale] = useState<ShowcaseData["scale"] | null>(null);
  const [failurePlatform, setFailurePlatform] = useState("");
  const [error, setError] = useState("");

  const nowTick = useNow(30_000);

  useEffect(() => {
    api.fleet.summary().then(setData).catch(e => setError(e.message));
    api.fleet.loadHistory(48).then(setLoad).catch(() => {});
    api.fleet.showcase().then(d => setScale(d.scale)).catch(() => {});
  }, []);

  useEffect(() => {
    setFailures(null);
    api.fleet.failures(7, failurePlatform || undefined).then(setFailures).catch(() => {});
  }, [failurePlatform]);

  // Keep the dashboard live: silently refresh everything while the tab is visible.
  usePoll(() => {
    api.fleet.summary().then(setData).catch(() => {});
    api.fleet.loadHistory(48).then(setLoad).catch(() => {});
    api.fleet.showcase().then(d => setScale(d.scale)).catch(() => {});
    api.fleet.failures(7, failurePlatform || undefined).then(setFailures).catch(() => {});
  }, 60_000);

  if (error) return <div className="p-8 text-red-400 text-sm">{error}</div>;
  if (!data) return (
    <div className="p-8 flex items-center gap-3 text-gray-500 text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
      Loading fleet data…
    </div>
  );

  const platforms = (() => {
    let mac = 0, linux = 0, windows = 0;
    Object.entries(data.by_pool).forEach(([name, count]) => {
      if (name.includes("osx")) mac += count;
      else if (name.includes("linux")) linux += count;
      else if (name.includes("win") || name.includes("nuc")) windows += count;
    });
    return [
      { name: "macOS" as const,   value: mac,     color: PLATFORM_COLORS.macOS },
      { name: "Linux" as const,   value: linux,   color: PLATFORM_COLORS.Linux },
      { name: "Windows" as const, value: windows, color: PLATFORM_COLORS.Windows },
    ].filter(d => d.value > 0);
  })();
  const platformTotal = platforms.reduce((s, p) => s + p.value, 0) || 1;

  // Health ring is scoped to macOS hardware — the fleet RelOps actually owns — to cut noise.
  const attention = data.attention_mac.quarantined + data.attention_mac.missing_from_tc;
  const macTotal = platforms.find(p => p.name === "macOS")?.value ?? 0;
  const healthPct = macTotal > 0 ? Math.round((1 - attention / macTotal) * 100) : 100;

  const lastSync = Object.values(data.sync_status).map(s => s.last_success).filter(Boolean).sort().pop() ?? null;

  // Greeting (client-local time)
  const now = new Date();
  const hr = now.getHours();
  const greeting = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const dateStr = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  // Load
  const totalsSeries = load?.totals ?? [];
  const curPending = totalsSeries.length ? totalsSeries[totalsSeries.length - 1].pending : null;
  const curRunning = totalsSeries.length ? totalsSeries[totalsSeries.length - 1].running : null;
  const haveTrend = totalsSeries.length >= 2;
  const topLoad = (load?.pools ?? []).filter(p => (p.pending ?? 0) > 0).slice(0, 6);
  const maxPending = topLoad.reduce((m, p) => Math.max(m, p.pending ?? 0), 1);

  const grad = { backgroundImage: FF_GRADIENT } as const;

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      {/* Greeting */}
      <div className="flex items-end justify-between">
        <div className="space-y-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-gray-600">{dateStr}</div>
          <h1 className="text-3xl font-light text-white tracking-tight">{greeting}</h1>
        </div>
        <div className="flex items-center gap-4">
          <WeatherChip />
          <span className="text-[11px] text-gray-600 flex items-center gap-1.5 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/80" /> synced {timeAgo(lastSync, nowTick)}
          </span>
        </div>
      </div>

      {/* Firefox release schedule */}
      <ReleaseScheduleCard />

      {/* Fleet load */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            <Gauge size={13} className="text-gray-500" /> Fleet Load
            <span className="flex items-center gap-1 text-[10px] text-gray-600 normal-case tracking-normal font-normal">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> live
            </span>
          </h3>
          <a href={yardstickAll} target="_blank" rel="noopener noreferrer"
            className="text-[11px] text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1">
            Trends in Yardstick <ArrowUpRight size={12} />
          </a>
        </div>

        <div className="flex flex-col lg:flex-row gap-6">
          {/* Current + trend */}
          <div className="lg:w-1/2">
            <div className="flex items-end gap-6">
              <div>
                <div className="text-4xl font-bold tabular-nums bg-clip-text text-transparent leading-none" style={grad}>
                  {curPending === null ? "—" : curPending.toLocaleString()}
                </div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wider mt-1.5">pending tasks</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-200 tabular-nums leading-none">{curRunning === null ? "—" : curRunning.toLocaleString()}</div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wider mt-1.5">running</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-200 tabular-nums leading-none">{scale ? scale.worker_hours.toLocaleString() : "—"}</div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wider mt-1.5">
                  worker-hrs{scale ? <span className="text-gray-600 normal-case"> · last {Math.round(scale.window_hours)}h</span> : null}
                </div>
              </div>
            </div>
            <div className="mt-4 h-16">
              {haveTrend ? (
                <Sparkline points={totalsSeries.map(t => t.pending)} />
              ) : (
                <div className="h-16 flex items-center text-[11px] text-gray-600 border border-dashed border-gray-800 rounded-lg px-3">
                  Collecting load history — the trend line fills in over the next hour.
                </div>
              )}
            </div>
            <div className="text-[10px] text-gray-600 mt-1">
              {haveTrend ? `last ${load?.hours}h · ${load?.sample_count.toLocaleString()} samples` : "sampling every 5 min"}
            </div>
          </div>

          {/* Top pools by pending */}
          <div className="lg:w-1/2 lg:border-l lg:border-gray-800/60 lg:pl-6">
            <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-3">Busiest pools — pending now</div>
            {topLoad.length === 0 ? (
              <div className="text-xs text-gray-600 py-4">No pending tasks across sampled pools.</div>
            ) : (
              <div className="space-y-2">
                {topLoad.map(p => (
                  <a key={p.pool} href={yardstickPool(p.pool)} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-3 group">
                    <span className="text-[11px] font-mono text-gray-400 group-hover:text-gray-200 transition-colors w-48 flex-shrink-0 truncate" title={p.pool}>
                      {p.pool}
                    </span>
                    <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${((p.pending ?? 0) / maxPending) * 100}%`, backgroundImage: FF_GRADIENT }} />
                    </div>
                    <span className="text-[11px] font-mono text-gray-300 tabular-nums w-12 text-right">{(p.pending ?? 0).toLocaleString()}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Monitored pools — user-pinned */}
      <MonitoredPools load={load} />

      {/* Total workers breakdown */}
      <div className="card p-6">
        <div className="flex flex-col md:flex-row items-center gap-8">
          <HealthRing pct={healthPct}>
            <span className="text-2xl font-bold text-white tabular-nums leading-none">{healthPct}%</span>
            <span className="text-[10px] uppercase tracking-wider text-gray-500 mt-1">healthy</span>
          </HealthRing>

          <div className="flex-1 w-full space-y-5">
            <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
              <div>
                <div className="text-4xl font-bold text-white tabular-nums leading-none">{data.total_workers.toLocaleString()}</div>
                <div className="text-[11px] text-gray-500 uppercase tracking-wider mt-1.5">Total workers</div>
              </div>
            </div>

            <div className="pt-4 border-t border-gray-800/60">
              <div className="flex w-full h-2.5 rounded-full overflow-hidden gap-px">
                {platforms.map(p => (
                  <div key={p.name} style={{ width: `${(p.value / platformTotal) * 100}%`, backgroundColor: p.color }} title={`${p.name}: ${p.value}`} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 mt-3">
                {platforms.map(p => (
                  <div key={p.name} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                    <span className="text-xs text-gray-300">{p.name}</span>
                    <span className="text-xs font-mono text-gray-400 tabular-nums">{p.value.toLocaleString()}</span>
                    <span className="text-[10px] text-gray-600 tabular-nums">{Math.round((p.value / platformTotal) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Failure Insights */}
      <div className="pt-2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Failure Insights · last 7 days</h2>
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
    </div>
  );
}
