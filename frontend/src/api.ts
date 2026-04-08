/** Typed API client for the RelOps backend. */

const BASE = "/api";

async function get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const url = new URL(path, window.location.origin);
  url.pathname = BASE + path;
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined) url.searchParams.set(k, String(v));
    });
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url.pathname}`);
  return res.json();
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkerMDM {
  id: number | null;
  name: string | null;
  serial_number: string | null;
  os_version: string | null;
  enrollment_status: string | null;
  groups: string | null;
  safari_driver: string | null;
  video_dongle: string | null;
  worker_config: string | null;
  refresh_hz: string | null;
  resolution: string | null;
}

export interface WorkerTC {
  worker_id: string | null;
  worker_group: string | null;
  state: string | null;
  last_active: string | null;
  quarantined: boolean | null;
  quarantine_until: string | null;
  first_claim: string | null;
  latest_task_id: string | null;
  latest_task_state: string | null;
  worker_pool_id: string | null;
}

export interface Worker {
  hostname: string;
  worker_id: string | null;
  generation: string | null;
  worker_pool: string | null;
  puppet_role: string | null;
  state: string | null;
  kvm: string | null;
  loaner_assignee: string | null;
  notes: string | null;
  mdm: WorkerMDM;
  tc: WorkerTC;
  sync: Record<string, string | null>;
  updated_at: string | null;
}

export interface WorkerListResponse {
  total: number;
  workers: Worker[];
}

export interface Alert {
  id: number;
  alert_type: string;
  hostname: string;
  detail: string | null;
  created_at: string | null;
  resolved_at: string | null;
  acknowledged: boolean;
  active: boolean;
  worker: {
    generation: string | null;
    worker_pool: string | null;
    state: string | null;
  };
}

export interface AlertListResponse {
  total: number;
  alerts: Alert[];
}

export interface SyncStatus {
  last_success: string | null;
  records_updated: number | null;
}

export interface FleetSummary {
  total_workers: number;
  by_generation: Record<string, number>;
  by_state: Record<string, number>;
  by_pool: Record<string, number>;
  by_os: Record<string, number>;
  alerts: { quarantined: number; missing_from_tc: number; mdm_unenrolled: number };
  sync_status: Record<string, SyncStatus>;
}

export interface ConsolidationData {
  r8: { total: number; by_state: Record<string, number>; by_pool: Record<string, number>; inactive_30d_count: number; inactive_30d_sample: string[] };
  m4: { total: number; by_state: Record<string, number>; by_pool: Record<string, number>; inactive_30d_count: number; inactive_30d_sample: string[] };
  retirement_candidates: string[];
  retirement_candidate_count: number;
  analysis: { r8_production_count: number; m4_production_count: number; r8_safe_to_retire_estimate: number };
}

// ── API calls ──────────────────────────────────────────────────────────────

export const api = {
  fleet: {
    summary: () => get<FleetSummary>("/fleet/summary"),
    consolidation: () => get<ConsolidationData>("/fleet/consolidation"),
  },
  workers: {
    list: (params?: Parameters<typeof get>[1]) => get<WorkerListResponse>("/workers", params),
    get: (hostname: string) => get<Worker>(`/workers/${hostname}`),
  },
  alerts: {
    list: (activeOnly = true) => get<AlertListResponse>("/alerts", { active_only: activeOnly }),
    resolve: (id: number) => post<Alert>(`/alerts/${id}/resolve`),
    acknowledge: (id: number) => post<Alert>(`/alerts/${id}/acknowledge`),
  },
  sync: {
    run: () => post<{ status: string }>("/sync/run"),
  },
};
