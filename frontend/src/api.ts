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

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
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
  found_in: { puppet: boolean; mdm: boolean; tc: boolean };
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
  by_generation_mdm: Record<string, number>;
  by_state: Record<string, number>;
  by_pool: Record<string, number>;
  by_os: Record<string, number>;
  alerts: { quarantined: number; quarantined_non_staging: number; missing_from_tc: number; mdm_unenrolled: number };
  attention_mac: { quarantined: number; missing_from_tc: number };
  branch_overrides: { total: number; by_branch: Record<string, number>; by_pool: Record<string, number> };
  sync_status: Record<string, SyncStatus>;
}

export interface PoolHealth {
  name: string;
  provisioner: string | null;
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

export interface PoolSources {
  pool: string;
  sample_size: number;
  by_project: Record<string, number>;
  by_user: Record<string, number>;
}

export interface CloudPool {
  id: string;
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

export interface LoadPoint {
  ts: string;
  pending: number;
  running: number;
}

export interface PoolLoadSnapshot {
  pool: string;
  pending: number | null;
  running: number | null;
  capacity: number | null;
  ts: string;
}

export interface LoadHistory {
  hours: number;
  since: string;
  sample_count: number;
  totals: LoadPoint[];
  pools: PoolLoadSnapshot[];
}

export interface MonitoredPoolsResponse {
  email: string;
  pools: string[];
}

export interface TrackedPoolsResponse {
  email: string;
  tracked: Record<string, string[]>;
}

// ── Release schedule ─────────────────────────────────────────────────────────

export interface ReleaseChannel {
  channel: string;
  label: string;
  version: string;
  release_notes: string | null;
}
export interface ReleaseMilestone {
  key: string;
  label: string;
  date: string;
}
export interface UpcomingRelease {
  version: string;
  date: string;
  release_notes: string;
}
export interface ReleaseSchedule {
  next_release: { version: string; date: string | null; release_notes: string | null } | null;
  channels: ReleaseChannel[];
  milestones: ReleaseMilestone[];
  upcoming: UpcomingRelease[];
  sources: string[];
}

// ── Weather (opt-in) ─────────────────────────────────────────────────────────

export interface WeatherNow {
  temp: number | null;
  feels_like: number | null;
  code: number | null;
  is_day: boolean;
  wind: number | null;
  humidity: number | null;
  temp_unit: string;
  wind_unit: string;
  observed_at: string | null;
}
export interface GeocodeResult {
  name: string;
  admin1: string | null;
  country: string | null;
  country_code: string | null;
  lat: number;
  lon: number;
}
export interface WeatherPref {
  enabled: boolean;
  label: string;
  lat: number | null;
  lon: number | null;
  unit: string;
}

// ── API calls ──────────────────────────────────────────────────────────────

export const api = {
  fleet: {
    summary: () => get<FleetSummary>("/fleet/summary"),
    pools: () => get<PoolsResponse>("/fleet/pools"),
    pendingCounts: () => get<PendingCountsResponse>("/fleet/pending-counts"),
    poolSources: (pool: string) => get<PoolSources>("/fleet/pool-sources", { pool }),
    failures: (days = 7, platform?: string) => get<FailureInsights>("/fleet/failures", { days, platform }),
    loadHistory: (hours = 48) => get<LoadHistory>("/fleet/load-history", { hours }),
    cloudPools: () => get<CloudPoolsResponse>("/fleet/cloud-pools"),
    androidPools: () => get<CloudPoolsResponse>("/fleet/android-pools"),
    androidPoolSources: (pool: string) => get<PoolSources>("/fleet/android-pool-sources", { pool }),
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
  releases: {
    schedule: () => get<ReleaseSchedule>("/releases"),
  },
  weather: {
    current: (lat: number, lon: number, unit: string) =>
      get<WeatherNow>("/weather", { lat, lon, unit }),
    geocode: (q: string) => get<{ results: GeocodeResult[] }>("/weather/geocode", { q }),
  },
  sync: {
    run: () => post<{ status: string }>("/sync/run"),
  },
  me: {
    monitoredPools: () => get<MonitoredPoolsResponse>("/me/monitored-pools"),
    setMonitoredPools: (pools: string[]) => put<MonitoredPoolsResponse>("/me/monitored-pools", { pools }),
    trackedPools: () => get<TrackedPoolsResponse>("/me/tracked-pools"),
    setTrackedPools: (section: string, pools: string[]) =>
      put<TrackedPoolsResponse>("/me/tracked-pools", { section, pools }),
    weather: () => get<{ email: string; weather: WeatherPref }>("/me/weather"),
    setWeather: (w: WeatherPref) => put<{ email: string; weather: WeatherPref }>("/me/weather", w),
  },
};
