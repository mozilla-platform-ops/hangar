import { useEffect, useRef, useState } from "react";
import { Check, Copy, Eraser, Lock, RefreshCw, Terminal, Zap } from "lucide-react";
import { api, type ReprovisionEventItem, type ReprovisionJob, type ReprovisionStatus } from "../api";
import { Badge } from "./Badge";

// Apple six-color rainbow — the same palette the `reprovision` CLI paints its steps with
// (orchestrator/ui.py). We reuse it here so the Hangar timeline reads like the terminal.
const APPLE = ["#61BB46", "#FDB827", "#F5821F", "#E03A3E", "#963D97", "#009DDC"];
// macOS window traffic-light dots: red (close), yellow (minimize), green (zoom).
const MAC_DOTS = ["#FF5F56", "#FEBD2E", "#28C840"];
const ACTIVE_STATES = new Set(["queued", "claimed", "running"]);

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function elapsed(from: string | null, to: string | null): string {
  if (!from) return "";
  const end = to ? new Date(to).getTime() : Date.now();
  const s = Math.max(0, Math.floor((end - new Date(from).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type LineKind = "step" | "wire" | "ok" | "warn" | "err" | "waiting" | "summary" | "plain";

function classify(detail: string): LineKind {
  const t = detail.trimStart();
  if (t.startsWith("██") || /reprovisioned in/.test(t)) return "summary";
  if (t.startsWith("▸")) return "step";
  if (t.startsWith("»")) return "wire";
  if (t.startsWith("✓")) return "ok";
  if (t.startsWith("▲")) return "warn";
  if (t.startsWith("✗")) return "err";
  if (t.startsWith("…") || t.startsWith("⏳") || /waiting|polling/i.test(t)) return "waiting";
  return "plain";
}

/** Tag each line with the 0-based index of the step it belongs to (drives the rainbow cycle). */
function withStepIndex(events: ReprovisionEventItem[]): { e: ReprovisionEventItem; stepIndex: number }[] {
  let seen = 0;
  return events.map((e) => {
    const isStep = classify(e.detail ?? e.action) === "step";
    const stepIndex = isStep ? seen++ : Math.max(0, seen - 1);
    return { e, stepIndex };
  });
}

/** One streamed CLI line, styled to match the terminal. `stepIndex` cycles the Apple rainbow. */
function TimelineLine({ e, stepIndex }: { e: ReprovisionEventItem; stepIndex: number }) {
  const raw = e.detail ?? e.action;
  const kind = classify(raw);

  if (kind === "summary") {
    return (
      <div className="flex items-center gap-2 py-1.5 mt-1">
        <span className="inline-flex rounded-sm overflow-hidden shadow-sm">
          {APPLE.map((c) => (
            <span key={c} style={{ backgroundColor: c }} className="w-3 h-3.5" />
          ))}
        </span>
        <span className="text-emerald-300 font-semibold">{raw.replace(/█/g, "").trim()}</span>
      </div>
    );
  }

  if (kind === "step") {
    const color = APPLE[stepIndex % APPLE.length];
    return (
      <div className="flex items-baseline gap-2 pt-2 pb-0.5">
        <span style={{ color }} className="font-semibold">
          {raw.trim()}
        </span>
      </div>
    );
  }

  const cls = {
    wire: "text-gray-500",
    ok: "text-emerald-400",
    warn: "text-amber-400",
    err: "text-red-400",
    waiting: "text-sky-400",
    plain: "text-gray-400",
  }[kind as Exclude<LineKind, "step" | "summary">];

  return <div className={`pl-3 ${cls} whitespace-pre-wrap break-words`}>{raw}</div>;
}

/** Terminal-styled live view of a reprovision's streamed steps. */
function RainbowTimeline({ job, events, onClear }: { job: ReprovisionJob | null; events: ReprovisionEventItem[]; onClear?: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const chrono = [...events].reverse(); // API returns newest-first; a terminal reads top→bottom
  const active = !!job && ACTIVE_STATES.has(job.state);

  // Auto-scroll to the newest line while a job streams.
  useEffect(() => {
    if (active && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [events.length, active]);

  return (
    <div className="rounded-lg border border-gray-800 bg-black/60 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800/80 bg-gray-950/60">
        <span className="flex items-center gap-1.5">
          {MAC_DOTS.map((c) => (
            <span key={c} style={{ backgroundColor: c }} className="w-2 h-2 rounded-full" />
          ))}
          <span className="ml-1.5 text-[10px] text-gray-500 font-mono">reprovision · live</span>
        </span>
        <span className="flex items-center gap-2 text-[10px] font-mono">
          {job && (
            <>
              <span className="text-gray-500 tabular-nums">
                {elapsed(job.claimed_at ?? job.created_at, active ? null : job.finished_at)}
              </span>
              <Badge
                label={job.state}
                variant={job.state === "succeeded" ? "green" : job.state === "failed" ? "red" : active ? "yellow" : "gray"}
                dot
                pulse={active}
              />
            </>
          )}
          {onClear && !active && (
            <button
              onClick={onClear}
              title="Clear the timeline (audit log is kept; a new run brings it back)"
              className="flex items-center gap-1 text-gray-600 hover:text-gray-300 transition-colors"
            >
              <Eraser size={11} /> clear
            </button>
          )}
        </span>
      </div>
      <div ref={scroller} className="max-h-[48rem] overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        {withStepIndex(chrono).map(({ e, stepIndex }, i) => (
          <TimelineLine key={i} e={e} stepIndex={stepIndex} />
        ))}
        {active && (
          <div className="pl-3 text-sky-400 animate-pulse">
            <span className="inline-block w-2 h-3.5 bg-sky-400/80 align-middle" /> streaming…
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Allowlist-gated reprovision cockpit. Renders nothing for non-authorized users. Shows a
 * worker's reprovision readiness (live) and — when the on-network runner is enabled — an
 * Execute button that enqueues a job the runner drains over mTLS, streaming each step into a
 * live Apple-rainbow terminal timeline. When no runner is enabled it falls back to the exact
 * CLI command to run on the VPN plus an audit ledger.
 */
export function ReprovisionPanel({ hostname }: { hostname: string }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [status, setStatus] = useState<ReprovisionStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  // Client-side "clear" for the timeline: hide everything up to this timestamp. Persisted
  // per host so it survives refresh; a newer run (events past it) reappears automatically.
  const [clearedAt, setClearedAt] = useState("");

  useEffect(() => {
    api.reprovision.access().then((a) => setAuthorized(a.authorized)).catch(() => setAuthorized(false));
  }, []);

  useEffect(() => {
    try {
      setClearedAt(localStorage.getItem(`reprovision:cleared:${hostname}`) ?? "");
    } catch {
      setClearedAt("");
    }
  }, [hostname]);

  const load = () => {
    api.reprovision.status(hostname).then(setStatus).catch((e) => setErr((e as Error).message));
  };

  const active = !!status?.active_job && ACTIVE_STATES.has(status.active_job.state);
  // Poll fast while a job streams, slow when idle.
  useEffect(() => {
    if (authorized !== true) return;
    load();
    const id = setInterval(load, active ? 3_000 : 8_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, hostname, active]);

  if (authorized !== true) return null;

  const r = status?.readiness;
  const cmd = status?.plan.one_command ?? "";
  const runnerEnabled = !!status?.runner_enabled;
  const supported = !!r?.supported;
  const lastJob = status?.last_job ?? null;
  // Timeline events newer than the client-side "clear" mark.
  const visibleEvents = (status?.events ?? []).filter((e) => !clearedAt || !e.at || e.at > clearedAt);

  function clearTimeline() {
    const newest = status?.events?.[0]?.at ?? "";
    if (!newest) return;
    try {
      localStorage.setItem(`reprovision:cleared:${hostname}`, newest);
    } catch {
      /* localStorage blocked — ignore */
    }
    setClearedAt(newest);
  }

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  async function execute() {
    if (busy || active) return;
    setBusy(true);
    setErr("");
    try {
      await api.reprovision.enqueue(hostname);
      setConfirm(false);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function initiate() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await api.reprovision.initiate(hostname);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 card-glow-blue">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-[0.1em] flex items-center gap-2">
          <RefreshCw size={12} className={`text-brand-400 ${active ? "animate-spin" : ""}`} /> Reprovision
        </h3>
        <span className="inline-flex items-center gap-1 text-[10px] text-gray-500" title="Limited to authorized operators">
          <Lock size={10} /> restricted
        </span>
      </div>

      {!status ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-gray-200">{r!.status}</div>

          <div className="flex items-center gap-2 flex-wrap">
            <Badge label={r!.quarantined ? "quarantined" : "in pool"} variant={r!.quarantined ? "red" : "green"} dot pulse={!r!.quarantined} />
            <Badge label={r!.running_task ? "running a task" : "idle"} variant={r!.running_task ? "yellow" : "gray"} dot pulse={r!.running_task} />
            {r!.generation && <Badge label={r!.generation.toUpperCase()} variant="blue" />}
            {!supported && <Badge label="EACS flow: M4 only" variant="orange" />}
          </div>

          {lastJob && !active && (
            <div className="text-[11px] flex items-center gap-1.5">
              <span className="text-gray-600">last run</span>
              <span className={lastJob.state === "succeeded" ? "text-emerald-400" : lastJob.state === "failed" ? "text-red-400" : "text-gray-400"}>
                {lastJob.state === "succeeded" ? "✓ succeeded" : lastJob.state === "failed" ? "✗ failed" : lastJob.state}
              </span>
              <span className="text-gray-600">· {timeAgo(lastJob.finished_at ?? lastJob.created_at)}</span>
            </div>
          )}

          {/* One-click execute — only when the on-network runner is wired up. */}
          {runnerEnabled && (
            <div className="border-t border-gray-800/60 pt-3">
              {!confirm ? (
                <button
                  onClick={() => setConfirm(true)}
                  disabled={active || !supported}
                  className="group relative w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-white overflow-hidden transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: `linear-gradient(90deg, ${APPLE.join(", ")})` }}
                  title={!supported ? "EACS reprovision is M4-only" : active ? "a reprovision is already running" : "Wipe + re-enroll this worker"}
                >
                  <span className="absolute inset-[1.5px] rounded-[7px] bg-gray-950/85 group-hover:bg-gray-950/70 transition-colors" />
                  <Zap size={14} className="relative" />
                  <span className="relative">{active ? "Reprovision running…" : "Reprovision this worker"}</span>
                </button>
              ) : (
                <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-3 space-y-2.5">
                  <p className="text-xs text-red-200">
                    This <span className="font-semibold">wipes {status.short}</span> (EACS) and re-enrolls it via the on-network runner. It stays quarantined afterward.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={execute}
                      disabled={busy}
                      className="flex items-center gap-1.5 text-xs font-semibold bg-red-600 hover:bg-red-500 text-white rounded-lg px-3 py-1.5 transition-all disabled:opacity-50"
                    >
                      <Zap size={13} className={busy ? "animate-pulse" : ""} /> {busy ? "Enqueueing…" : "Yes, reprovision"}
                    </button>
                    <button
                      onClick={() => setConfirm(false)}
                      disabled={busy}
                      className="text-xs text-gray-400 hover:text-gray-200 rounded-lg px-3 py-1.5 transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Live timeline — shows the active job streaming, or the last run's trail. */}
          {(status.active_job || visibleEvents.length > 0) && (
            <RainbowTimeline job={status.active_job} events={visibleEvents} onClear={clearTimeline} />
          )}

          {/* CLI handoff — always available (manual / on-VPN path). */}
          <div>
            <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <Terminal size={11} /> {runnerEnabled ? "or run manually on the VPN" : "run on the VPN"}
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-xs bg-gray-950/70 border border-gray-800 rounded-lg px-3 py-2 text-brand-300 overflow-x-auto">
                {cmd}
              </code>
              <button
                onClick={copyCmd}
                title="Copy command"
                className="flex items-center text-xs bg-gray-800/60 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-lg px-2.5 py-2 transition-all"
              >
                {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              </button>
            </div>
            {!runnerEnabled && <p className="text-[11px] text-gray-600 mt-1.5">{status.plan.note}</p>}
            {!runnerEnabled && (
              <button
                onClick={initiate}
                disabled={busy}
                className="mt-2 text-[11px] text-gray-500 hover:text-gray-300 underline underline-offset-2 disabled:opacity-40"
              >
                {busy ? "logging…" : "log a manual reprovision start"}
              </button>
            )}
          </div>

          {err && <div className="text-red-400 text-xs">{err}</div>}
        </div>
      )}
    </div>
  );
}
