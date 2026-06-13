import { useId } from "react";

/** Smooth area sparkline with the Firefox gradient. Crisp stroke at any width.
 *  Gradient ids are instance-unique (useId) so many sparklines can coexist. */
export function Sparkline({ points, className = "w-full h-16", animate = true }: {
  points: number[];
  className?: string;
  animate?: boolean;
}) {
  const uid = useId();
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
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`${className} ${animate ? "spark-svg" : ""}`}>
      <defs>
        <linearGradient id={`${uid}-stroke`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FF9400" />
          <stop offset="50%" stopColor="#FF1AD9" />
          <stop offset="100%" stopColor="#9059FF" />
        </linearGradient>
        <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FF1AD9" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#FF1AD9" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${uid}-fill)`} />
      <path d={line} fill="none" stroke={`url(#${uid}-stroke)`} strokeWidth={2} vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={3.5} fill="#FF1AD9" vectorEffect="non-scaling-stroke" className={animate ? "spark-dot" : ""} />
    </svg>
  );
}
