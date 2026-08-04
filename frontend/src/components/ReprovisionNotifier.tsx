import { useEffect, useRef } from "react";
import { api, type ReprovisionJob } from "../api";

const ACTIVE = new Set(["queued", "claimed", "running"]);
const TERMINAL = new Set(["succeeded", "failed"]);

function fire(j: ReprovisionJob) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const ok = j.state === "succeeded";
  const detail = (j.detail ?? "").replace(/█/g, "").trim().slice(0, 140);
  const n = new Notification(`Reprovision ${ok ? "succeeded ✓" : "failed ✗"}`, {
    body: `${j.short}${detail ? " — " + detail : ""}`,
    tag: `reprovision-${j.id}`, // dedupe if multiple tabs fire
  });
  n.onclick = () => {
    window.focus();
    window.location.href = `/workers/${j.short}`;
  };
}

/**
 * App-wide desktop notification when a reprovision finishes. Renders nothing. Polls the
 * (allowlist-gated) jobs endpoint; when a job we saw as active flips to succeeded/failed, it
 * fires a browser Notification. Non-authorized users get a 403 → no polling side effects, no
 * notifications. Fires only for transitions observed after load (won't replay old jobs).
 */
export function ReprovisionNotifier() {
  const known = useRef<Map<number, string>>(new Map());
  const primed = useRef(false);

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    let cancelled = false;

    const poll = async () => {
      let jobs: ReprovisionJob[];
      try {
        jobs = (await api.reprovision.jobs()).jobs;
      } catch {
        return; // 403 for non-authorized, or transient — just skip this tick
      }
      if (cancelled) return;
      for (const j of jobs) {
        const prev = known.current.get(j.id);
        if (primed.current && prev && ACTIVE.has(prev) && TERMINAL.has(j.state)) {
          fire(j);
        }
        known.current.set(j.id, j.state);
      }
      primed.current = true; // first pass just establishes a baseline
    };

    poll();
    // Deliberately NOT usePoll: this must keep polling while the tab is hidden, or
    // "notify when the reprovision finishes" only fires once you look back at hangar
    // — which is the one moment you don't need telling. Same trade as the try-push
    // poll in Overview.
    //
    // But it is app-wide and renders nothing, so every open tab paid for it forever.
    // At 15s that was 4 req/min/tab and made this endpoint 57% of all LB traffic,
    // pushing a normal session near the Cloud Armor ceiling (100 req/60s per IP) so a
    // quick refresh got denied. 60s is still far finer than reprovisions resolve —
    // they take many minutes — and cuts this source 4x.
    const id = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return null;
}
