import type { Hover } from "../lib/useHover";

/** Fixed-position hover card, same treatment as the Fleet Map's. */
export function HoverCard({ hover }: { hover: Hover | null }) {
  if (!hover) return null;
  return (
    <div
      className="fixed z-50 pointer-events-none card px-3 py-2 text-xs shadow-xl max-w-xs"
      style={{ left: Math.min(hover.x + 14, window.innerWidth - 300), top: hover.y + 14 }}
    >
      {hover.body}
    </div>
  );
}
