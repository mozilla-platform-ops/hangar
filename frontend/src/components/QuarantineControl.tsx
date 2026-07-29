import { useState, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Ban, ShieldCheck, Loader2, ChevronDown } from "lucide-react";
import { api, type QuarantineDuration } from "../api";

const DURATIONS: { key: QuarantineDuration; label: string }[] = [
  { key: "1h", label: "1 hour" },
  { key: "4h", label: "4 hours" },
  { key: "1d", label: "1 day" },
  { key: "1w", label: "1 week" },
  { key: "indefinite", label: "Indefinite" },
];

function untilLabel(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  // Far-future "indefinite" marker (year 3000).
  if (d.getUTCFullYear() >= 2900) return "indefinitely";
  return `until ${d.toLocaleString()}`;
}

/**
 * Allowlist-gated quarantine / un-quarantine control (same gate as reprovision).
 * Renders nothing for unauthorized users. Used both on the worker detail page
 * (full) and as a compact action in the fleet table row.
 */
export function QuarantineControl({
  hostname,
  quarantined,
  quarantineUntil,
  authorized,
  runnerEnabled,
  onChanged,
  compact = false,
}: {
  hostname: string;
  quarantined: boolean;
  quarantineUntil?: string | null;
  authorized: boolean;
  runnerEnabled: boolean;
  onChanged?: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [queued, setQueued] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  // The menu is rendered in a body portal so it escapes the surrounding card's
  // stacking context (cards use backdrop-blur → their own stacking context, and
  // the fleet table clips overflow), which otherwise hides it behind sibling
  // cards. Position it under the trigger; close on scroll/resize to avoid drift.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const MENU_W = 224; // w-56
    setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.right - MENU_W) });
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!authorized) return null;

  async function run(fn: () => Promise<unknown>, queuedMsg: string) {
    setBusy(true);
    setErr("");
    try {
      await fn();
      setOpen(false);
      setReason("");
      // The runner applies it asynchronously; reflect "queued" until the next sync.
      setQueued(queuedMsg);
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const disabledHint = !runnerEnabled
    ? "The reprovision runner isn't enabled"
    : undefined;
  const btnBase = compact
    ? "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
    : "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40";

  // Already quarantined → offer to lift.
  if (quarantined) {
    return (
      <div className="inline-flex flex-col items-start gap-1" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          disabled={busy || !runnerEnabled}
          title={disabledHint ?? (quarantineUntil ? `Quarantined ${untilLabel(quarantineUntil)}` : "Quarantined")}
          onClick={() => run(() => api.quarantine.lift(hostname), "un-quarantine queued")}
          className={`${btnBase} text-emerald-300 bg-emerald-950/40 border border-emerald-900/50 hover:bg-emerald-900/40`}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
          Un-quarantine
        </button>
        {queued && <span className="text-[10px] text-gray-500">{queued} — runner will apply</span>}
        {err && <span className="text-[10px] text-red-400 max-w-[220px]">{err}</span>}
      </div>
    );
  }

  // Not quarantined → quarantine with a duration.
  return (
    <div className="relative inline-block" onClick={e => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        disabled={busy || !runnerEnabled}
        title={disabledHint}
        onClick={() => setOpen(o => !o)}
        className={`${btnBase} text-amber-300 bg-amber-950/40 border border-amber-900/50 hover:bg-amber-900/40`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
        Quarantine
        <ChevronDown size={11} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {queued && !open && <div className="mt-1 text-[10px] text-gray-500">{queued} — runner will apply</div>}
      {err && !open && <div className="mt-1 text-[10px] text-red-400 max-w-[220px]">{err}</div>}
      {open && menuPos && createPortal(
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-[100]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[101] w-56 rounded-lg border border-gray-700 bg-gray-900 shadow-xl p-2"
            style={{ top: menuPos.top, left: menuPos.left }}
            onClick={e => e.stopPropagation()}
          >
            <div className="text-[10px] text-gray-500 uppercase tracking-wider px-1 pb-1">Quarantine for</div>
            <div className="flex flex-col">
              {DURATIONS.map(d => (
                <button
                  key={d.key}
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => api.quarantine.set(hostname, d.key, reason), `quarantine (${d.label}) queued`)}
                  className="text-left text-xs text-gray-300 hover:bg-gray-800 rounded px-2 py-1.5 transition-colors disabled:opacity-40"
                >
                  {d.label}
                </button>
              ))}
            </div>
            <input
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="reason (optional)"
              className="mt-2 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[11px] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
            {err && <div className="mt-1.5 text-[10px] text-red-400">{err}</div>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
