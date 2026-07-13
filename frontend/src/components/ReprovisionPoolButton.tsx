import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { api, type ReprovisionPoolPlan } from "../api";

/** EACS reprovision is Apple-Silicon (M4) only, so the pool button only shows for M4 pools. */
function isReprovisionablePool(pool: string): boolean {
  return /osx-1500-m4/.test(pool);
}

/**
 * One-click pool-wide reprovision, allowlist-gated. Previews the exact hosts it will EACS
 * (server enumerates only TC-registered hosts in the pool, excluding the runner + VM-repurposed
 * boxes + non-M4 + already-open jobs), shows them in a red confirm, then enqueues — the concurrent
 * runner wipes them in parallel. Renders nothing for non-authorized users or non-M4 pools.
 */
export function ReprovisionPoolButton({ pool }: { pool: string }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<ReprovisionPoolPlan | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.reprovision.access().then(a => { if (live) setAuthorized(a.authorized); }).catch(() => { if (live) setAuthorized(false); });
    return () => { live = false; };
  }, []);

  if (authorized !== true || !pool || !isReprovisionablePool(pool)) return null;

  async function preview() {
    setResult(null);
    try {
      setPlan(await api.reprovision.poolStatus(pool));
      setOpen(true);
    } catch {
      setResult("couldn't load pool");
    }
  }

  async function fire() {
    setBusy(true);
    try {
      const r = await api.reprovision.poolEnqueue(pool);
      setResult(r.count > 0 ? `Enqueued ${r.count}: ${r.enqueued.join(", ")}` : "Nothing eligible to enqueue");
      setOpen(false);
    } catch {
      setResult("enqueue failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={preview}
        title="EACS-reprovision every eligible host in this pool"
        className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-red-800/60 bg-red-950/40 text-red-300 hover:bg-red-900/50 hover:text-red-200 transition-all"
      >
        <AlertTriangle size={12} /> Reprovision pool
      </button>
      {result && <span className="ml-2 text-xs text-emerald-400">{result}</span>}

      {open && plan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="card max-w-lg w-full mx-4 p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <AlertTriangle size={15} className="text-red-400" /> Reprovision pool — <span className="font-mono text-gray-300">{plan.pool}</span>
              </h2>
              <button onClick={() => setOpen(false)} className="text-gray-600 hover:text-gray-300"><X size={15} /></button>
            </div>

            {!plan.runner_enabled && (
              <p className="text-xs text-yellow-400 mb-2">⚠ the on-network runner isn't enabled — jobs will queue but won't run.</p>
            )}

            {plan.eligible.length === 0 ? (
              <p className="text-sm text-gray-400">No eligible hosts to reprovision in this pool.</p>
            ) : (
              <>
                <p className="text-sm text-gray-300">
                  This will <span className="text-red-400 font-semibold">EACS-wipe {plan.eligible.length}</span> host{plan.eligible.length === 1 ? "" : "s"} (runs in parallel; each quarantines &amp; drains first):
                </p>
                <ul className="mt-2 mb-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono text-gray-300">
                  {plan.eligible.map(e => (
                    <li key={e.host} className="flex items-center gap-1.5">
                      {e.host}
                      {e.running_task && <span className="text-yellow-500/80 text-[10px]">running — will drain</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {plan.skipped.length > 0 && (
              <details className="mt-2 text-xs text-gray-500">
                <summary className="cursor-pointer hover:text-gray-300">{plan.skipped.length} skipped</summary>
                <ul className="mt-1 space-y-0.5">
                  {plan.skipped.map(s => <li key={s.host}><span className="font-mono">{s.host}</span> — {s.reason}</li>)}
                </ul>
              </details>
            )}

            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={fire}
                disabled={busy || plan.eligible.length === 0}
                className="text-xs font-semibold px-3 py-1.5 rounded-md bg-red-600/90 hover:bg-red-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {busy ? "Enqueuing…" : `Execute — wipe ${plan.eligible.length}`}
              </button>
              <button onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1.5">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
