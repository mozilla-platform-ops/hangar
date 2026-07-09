import { useEffect, useRef, useState } from "react";
import { Monitor, Pause, Play } from "lucide-react";
import { api, type ScreenLatest } from "../api";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * Worker live view — a periodic VNC screenshot. Allowlist-gated (renders nothing otherwise).
 * While the card is "live", it keeps the host marked watched and fetches the latest frame the
 * on-network agent has pushed (Cloud Run can't VNC to MDC1 directly). On-demand only: capture
 * stops the moment you pause or leave the page, so idle workers are never touched.
 */
export function WorkerScreen({ hostname }: { hostname: string }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [frame, setFrame] = useState<ScreenLatest | null>(null);
  const [live, setLive] = useState(true);
  const seenFrame = useRef(false);

  useEffect(() => {
    api.reprovision.access().then((a) => setAuthorized(a.authorized)).catch(() => setAuthorized(false));
  }, []);

  useEffect(() => {
    if (authorized !== true || !live) return;
    let cancelled = false;
    const tick = () => {
      api.screen.request(hostname).catch(() => {}); // keep the host "watched" (best-effort)
      api.screen
        .latest(hostname)
        .then((f) => {
          if (cancelled) return;
          if (f.data_url) seenFrame.current = true;
          setFrame(f);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authorized, live, hostname]);

  if (authorized !== true) return null;

  return (
    <div className="card p-5 card-glow-blue">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-[0.1em] flex items-center gap-2">
          <Monitor size={12} className="text-brand-400" /> Live view
        </h3>
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          {frame?.captured_at && <span className="tabular-nums">updated {timeAgo(frame.captured_at)}</span>}
          <button
            onClick={() => setLive((v) => !v)}
            title={live ? "Pause (stops capturing)" : "Resume"}
            className="flex items-center gap-1 text-gray-400 hover:text-gray-200 transition-colors"
          >
            {live ? <Pause size={11} /> : <Play size={11} />} {live ? "live" : "paused"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-gray-800 bg-black/70 overflow-hidden aspect-[16/10] flex items-center justify-center">
        {frame?.data_url ? (
          <img src={frame.data_url} alt={`${hostname} screen`} className="w-full h-full object-contain" />
        ) : (
          <div className="text-center text-gray-600 text-xs px-6">
            {!live ? (
              "paused"
            ) : seenFrame.current ? (
              <span className="inline-flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" /> refreshing…
              </span>
            ) : (
              <>
                <span className="inline-flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" /> waiting for a frame…
                </span>
                <div className="mt-1 text-[10px] text-gray-700">the on-network agent grabs one every ~15s while you watch</div>
              </>
            )}
          </div>
        )}
      </div>
      <p className="text-[10px] text-gray-600 mt-1.5">
        Passive VNC snapshot · captured only while this card is open · no input sent to the worker.
      </p>
    </div>
  );
}
