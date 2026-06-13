import type { Worker } from "../api";

export type HealthStatus = "healthy" | "degraded" | "critical" | null;
export interface HealthCounts { healthy: number; degraded: number; critical: number; other: number }

// Pools kept off the fleet map / TV view — signing and infra hosts that aren't
// test capacity and just add noise. Substring match (case-insensitive).
const MAP_EXCLUDED = ["signing", "deploystudio", "gecko-1-b-osx-arm64-vms-host"];

/** True if a worker belongs on the fleet map: has a pool, and isn't a
 *  signing/infra-host pool. Unassigned (no-pool) workers are dropped. */
export function inFleetMap(w: Worker): boolean {
  const pool = (w.worker_pool || "").toLowerCase();
  if (!pool) return false;
  return !MAP_EXCLUDED.some(frag => pool.includes(frag));
}

/** Per-worker health rollup shared by the Workers table and the fleet heatmap.
 *  null = not in production (spare/staging/loaner) — informational, not a problem. */
export function workerHealth(w: Worker): HealthStatus {
  if (w.state !== "production") return null;
  if (w.tc.quarantined) return "critical";
  const hrs = w.tc.last_active
    ? (Date.now() - new Date(w.tc.last_active).getTime()) / 36e5
    : Infinity;
  if (hrs > 168) return "critical";
  if (w.mdm.enrollment_status === "unenrolled" || hrs > 24) return "degraded";
  return "healthy";
}

export interface PoolGroup {
  name: string;
  workers: Worker[];
  counts: HealthCounts;
}

function tally(workers: Worker[]): HealthCounts {
  const c: HealthCounts = { healthy: 0, degraded: 0, critical: 0, other: 0 };
  for (const w of workers) {
    const h = workerHealth(w);
    if (h === "healthy") c.healthy++;
    else if (h === "degraded") c.degraded++;
    else if (h === "critical") c.critical++;
    else c.other++;
  }
  return c;
}

/** Fleet-wide health tally across all workers. */
export function fleetCounts(workers: Worker[]): HealthCounts {
  return tally(workers);
}

/** Group workers by pool with per-pool health tallies; worst pools first. */
export function groupByPool(workers: Worker[]): PoolGroup[] {
  const map = new Map<string, Worker[]>();
  for (const w of workers) {
    const pool = w.worker_pool || "unassigned";
    const arr = map.get(pool);
    if (arr) arr.push(w);
    else map.set(pool, [w]);
  }
  const groups: PoolGroup[] = [];
  for (const [name, ws] of map) {
    groups.push({ name, workers: ws, counts: tally(ws) });
  }
  groups.sort((a, b) =>
    b.counts.critical - a.counts.critical ||
    b.counts.degraded - a.counts.degraded ||
    b.workers.length - a.workers.length);
  return groups;
}
