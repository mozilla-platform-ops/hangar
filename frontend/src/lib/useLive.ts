import { useEffect, useRef, useState } from "react";

/**
 * Re-runs `fn` every `ms` while the tab is visible. Pauses when the tab is
 * hidden and fires immediately on return, so a dashboard left on a monitor
 * stays current without polling in the background.
 *
 * Does not call `fn` on mount — pages already fetch on mount themselves.
 */
export function usePoll(fn: () => void, ms: number) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    let timer: number | undefined;
    const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
    const start = () => { stop(); timer = window.setInterval(() => fnRef.current(), ms); };
    const onVisibility = () => {
      if (document.hidden) stop();
      else { fnRef.current(); start(); }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [ms]);
}

/** Current time, re-rendering every `ms` — keeps "x ago" labels ticking. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
