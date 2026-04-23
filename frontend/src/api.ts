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

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let msg = text;
    try { msg = JSON.parse(text).detail ?? text; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
  branch: string | null;
  git_version: string | null;
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
  platform: string | null;
  worker_pool: string | null;
  puppet_role: string | null;
  state: string | null;
  kvm: string | null;
  loaner_assignee: string | null;
  notes: string | null;
  dashboard_notes: string | null;
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
    dashboard_notes: string | null;
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
  alerts: { quarantined: number; quarantined_non_staging: number; missing_from_tc: number; mdm_unenrolled: number };
  branch_overrides: { total: number; by_branch: Record<string, number>; by_pool: Record<string, number> };
  sync_status: Record<string, SyncStatus>;
}

export interface PoolHealth {
  name: string;
  generation: string | null;
  total: number;
  production: number;
  quarantined: number;
  mdm_unenrolled: number;
  active_24h: number;
  stale_1_7d: number;
  stale_7_30d: number;
  stale_30d_plus: number;
  never_seen: number;
  branch_override_count: number;
  running_tasks: number;
  healthy: number;
  health_score: number;
  running_sources: Record<string, number>;
  top_owners: Array<{ email: string; count: number }>;
}

export interface PoolOpResult {
  total: number;
  succeeded: number;
  failed: Array<{ hostname: string; ok: boolean; error: string | null }>;
}

export interface PoolSources {
  pool: string;
  sample_size: number;
  by_project: Record<string, number>;
  by_user: Record<string, number>;
}

export interface CloudPool {
  name: string;
  provisioner: string;
  pending: number;
  running: number;
  total: number;
}

export interface CloudPoolsResponse {
  pools: CloudPool[];
}

export interface FailureInsights {
  machine_failures: Array<{
    hostname: string;
    short_hostname: string;
    worker_pool: string | null;
    count: number;
    last_at: string | null;
  }>;
  test_failures: Array<{ task_name: string; count: number; last_at: string | null }>;
  window_days: number;
  platform: string | null;
}

export interface PoolsResponse {
  pools: PoolHealth[];
}

export interface PendingCountsResponse {
  pending_counts: Record<string, number | null>;
}

export interface RoninPR {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string | null;
  labels: string[];
  created_at: string | null;
  updated_at: string | null;
  upvotes: number;
  downvotes: number;
  last_synced: string | null;
}

export interface RoninPRsResponse {
  total: number;
  prs: RoninPR[];
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
    pools: () => get<PoolsResponse>("/fleet/pools"),
    pendingCounts: () => get<PendingCountsResponse>("/fleet/pending-counts"),
    poolSources: (pool: string) => get<PoolSources>("/fleet/pool-sources", { pool }),
    failures: (days = 7, platform?: string) => get<FailureInsights>("/fleet/failures", { days, platform }),
    cloudPools: () => get<CloudPoolsResponse>("/fleet/cloud-pools"),
    androidPools: () => get<CloudPoolsResponse>("/fleet/android-pools"),
    consolidation: () => get<ConsolidationData>("/fleet/consolidation"),
  },
  pools: {
    setBranch: (poolName: string, branch: string, repo?: string, email?: string) =>
      post<PoolOpResult>(`/pools/${encodeURIComponent(poolName)}/set-branch`, { branch, repo, email }),
    clearBranch: (poolName: string) =>
      post<PoolOpResult>(`/pools/${encodeURIComponent(poolName)}/clear-branch`),
  },
  workers: {
    list: (params?: Parameters<typeof get>[1]) => get<WorkerListResponse>("/workers", params),
    get: (hostname: string) => get<Worker>(`/workers/${hostname}`),
    updateNotes: (hostname: string, notes: string | null) => patch<Worker>(`/workers/${hostname}/notes`, { notes }),
  },
  alerts: {
    list: (activeOnly = true) => get<AlertListResponse>("/alerts", { active_only: activeOnly }),
    resolve: (id: number) => post<Alert>(`/alerts/${id}/resolve`),
    acknowledge: (id: number) => post<Alert>(`/alerts/${id}/acknowledge`),
  },
  prs: {
    list: () => get<RoninPRsResponse>("/prs/ronin"),
    upvote: (n: number) => post<RoninPR>(`/prs/ronin/${n}/upvote`),
    downvote: (n: number) => post<RoninPR>(`/prs/ronin/${n}/downvote`),
  },
  sync: {
    run: () => post<{ status: string }>("/sync/run"),
  },
};
