import type { Alert } from "../api";

/**
 * The Alerts page's default "hide signing workers" filter. Shared by the
 * sidebar/tab-title badge so both report the same count.
 */
export function isSigningWorker(alert: Alert): boolean {
  if (!alert.hostname.startsWith("macmini-")) return true;
  if (alert.worker?.worker_pool?.includes("signing")) return true;
  return false;
}
