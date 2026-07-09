import { useEffect, useState } from "react";
import { Check, Copy, Lock, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { api, type ReprovisionStatus } from "../api";
import { usePoll } from "../lib/useLive";
import { Badge } from "./Badge";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Allowlist-gated reprovision cockpit. Renders nothing for non-authorized users. Shows a
 * worker's reprovision readiness (live), the exact CLI command to run on the VPN, and an
 * audit ledger — the SSH/destructive execution stays in the on-VPN `reprovision` CLI.
 */
export function ReprovisionPanel({ hostname }: { hostname: string }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [status, setStatus] = useState<ReprovisionStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.reprovision.access().then((a) => setAuthorized(a.authorized)).catch(() => setAuthorized(false));
  }, []);

  const load = () => {
    api.reprovision.status(hostname).then(setStatus).catch((e) => setErr((e as Error).message));
  };
  useEffect(() => {
    if (authorized) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, hostname]);
  usePoll(() => { if (authorized) load(); }, 8_000);

  // Hidden entirely unless the caller is on the allowlist.
  if (authorized !== true) return null;

  const r = status?.readiness;
  const cmd = status?.plan.one_command ?? "";

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
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
          <RefreshCw size={12} className="text-brand-400" /> Reprovision
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
            {!r!.supported && <Badge label="EACS flow: M4 only" variant="orange" />}
          </div>

          <div>
            <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <Terminal size={11} /> run on the VPN
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
            <p className="text-[11px] text-gray-600 mt-1.5">{status.plan.note}</p>
          </div>

          <div className="flex items-center gap-3 border-t border-gray-800/60 pt-3">
            <button
              onClick={initiate}
              disabled={busy}
              className="flex items-center gap-2 text-xs bg-brand-900/40 hover:bg-brand-900/60 border border-brand-800/50 text-brand-300 hover:text-brand-200 rounded-lg px-3 py-1.5 transition-all disabled:opacity-40"
            >
              <ShieldCheck size={13} className={busy ? "animate-pulse" : ""} />
              {busy ? "Logging…" : "Log reprovision start"}
            </button>
            <span className="text-[11px] text-gray-600">records who + when; execution is the command above</span>
          </div>
          {err && <div className="text-red-400 text-xs">{err}</div>}

          {status.events.length > 0 && (
            <div className="border-t border-gray-800/60 pt-3">
              <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">recent</div>
              <ul className="space-y-1">
                {status.events.map((e, i) => (
                  <li key={i} className="text-xs text-gray-400 flex items-center gap-2">
                    <span className="text-gray-500 tabular-nums">{timeAgo(e.at)}</span>
                    <span className="text-gray-300">{e.user.split("@")[0]}</span>
                    <span className="text-gray-500">{e.action}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
