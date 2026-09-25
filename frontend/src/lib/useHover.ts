import { useState, type MouseEvent, type ReactNode } from "react";

export type Hover = { x: number; y: number; body: ReactNode };

/** Hover state for a fixed-position card: spread `bind(body)` onto any mark. */
export function useHover() {
  const [hover, setHover] = useState<Hover | null>(null);
  const bind = (body: ReactNode) => ({
    onMouseEnter: (e: MouseEvent) => setHover({ x: e.clientX, y: e.clientY, body }),
    onMouseMove: (e: MouseEvent) => setHover({ x: e.clientX, y: e.clientY, body }),
    onMouseLeave: () => setHover(null),
  });
  return { hover, bind };
}
