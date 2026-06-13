import { useEffect, useRef, useState } from "react";

const REDUCED = typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A number that counts to its new value and pulses briefly when it changes,
 *  so live-poll updates are visible instead of silent. Honors reduced-motion. */
export function AnimatedNumber({ value, format, className = "" }: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const [pulse, setPulse] = useState(false);
  const prevRef = useRef(value);

  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = value;
    if (from === value || REDUCED) return;

    const start = performance.now();
    const dur = 600;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min((t - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * eased);
      setPulse(p < 1);                 // glow while animating, clears on the final frame
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString());
  if (REDUCED) return <span className={className}>{fmt(value)}</span>;
  return <span className={`${className} ${pulse ? "num-pulse" : ""}`}>{fmt(display)}</span>;
}
