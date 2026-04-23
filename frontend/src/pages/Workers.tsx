import { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel,
  flexRender,
} from "@tanstack/react-table";
import type { SortingState, ColumnDef } from "@tanstack/react-table";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { api } from "../api";
import type { Worker } from "../api";
import { stateBadge, tcStatusBadge, enrollmentBadge } from "../components/Badge";

type HealthStatus = "healthy" | "degraded" | "critical" | null;

function workerHealth(w: Worker): HealthStatus {
  if (w.state !== "production") return null;
  if (w.tc.quarantined) return "critical";
  const hrs = w.tc.last_active
    ? (Date.now() - new Date(w.tc.last_active).getTime()) / 36e5
    : Infinity;
  if (hrs > 168) return "critical";
  if (w.mdm.enrollment_status === "unenrolled" || hrs > 24) return "degraded";
  return "healthy";
}

function HealthDot({ status }: { status: HealthStatus }) {
  if (status === null) return <span className="w-1.5 h-1.5 rounded-full bg-gray-800 inline-block" />;
  const styles: Record<string, string> = {
    healthy:  "bg-emerald-400",
    degraded: "bg-yellow-400",
    critical: "bg-red-400 animate-pulse",
  };
  return <span className={`w-1.5 h-1.5 rounded-full inline-block ${styles[status]}`} />;
}

const PAGE_SIZE = 100;

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.round(diff / 36e5);
  if (hrs < 1) return "<1h ago";
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function Workers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [workers, setWorkers] = useState<Worker[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [page, setPage] = useState(0);
  const [poolOptions, setPoolOptions] = useState<string[]>([]);

  useEffect(() => {
    api.fleet.pools().then(d => setPoolOptions(d.pools.map((p: { name: string }) => p.name).sort()));
  }, []);

  const search = searchParams.get("search") || "";
  const generation = searchParams.get("generation") || "";
  const state = searchParams.get("state") || "";
  const pool = searchParams.get("worker_pool") || "";

  const SORT_MAP: Record<string, string> = {
    hostname: "hostname",
    generation: "generation",
    worker_pool: "worker_pool",
    os: "os_version",
    tc_last_active: "tc_last_active",
    tc_status: "tc_state",
    mdm: "mdm_enrollment_status",
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sortCol = sorting[0];
      const result = await api.workers.list({
        search: search || undefined,
        generation: generation || undefined,
        state: state || undefined,
        worker_pool: pool || undefined,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        sort_by: sortCol ? (SORT_MAP[sortCol.id] || sortCol.id) : "hostname",
        sort_dir: sortCol?.desc ? "desc" : "asc",
      });
      setWorkers(result.workers);
      setTotal(result.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, generation, state, pool, page, sorting]);

  useEffect(() => { load(); }, [load]);

  function setFilter(key: string, val: string) {
    setPage(0);
    const next = new URLSearchParams(searchParams);
    if (val) next.set(key, val); else next.delete(key);
    setSearchParams(next);
  }

  const hasFilters = !!(search || generation || state || pool);

  const columns: ColumnDef<Worker>[] = [
    {
      id: "health",
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-center w-4">
          <HealthDot status={workerHealth(row.original)} />
        </div>
      ),
    },
    {
      accessorKey: "hostname",
      header: "Hostname",
      cell: ({ row }) => (
        <button
          className="text-brand-400 hover:text-brand-300 font-mono text-xs truncate max-w-[180px] block transition-colors"
          onClick={() => navigate(`/workers/${row.original.hostname}`)}
        >
          {row.original.worker_id || row.original.hostname.split(".")[0]}
        </button>
      ),
    },
    {
      accessorKey: "generation",
      header: "Gen",
      cell: ({ getValue }) => {
        const gen = getValue() as string;
        const colors: Record<string, string> = { r8: "text-indigo-400", m2: "text-cyan-400", m4: "text-emerald-400" };
        return <span className={`text-xs font-mono font-medium ${colors[gen] || "text-gray-500"}`}>{gen || "?"}</span>;
      },
    },
    {
      accessorKey: "worker_pool",
      header: "Pool",
      cell: ({ getValue }) => (
        <span className="text-xs text-gray-400 font-mono truncate max-w-[160px] block">
          {(getValue() as string) || "—"}
        </span>
      ),
    },
    {
      id: "state",
      header: "State",
      cell: ({ row }) => stateBadge(row.original.state),
    },
    {
      id: "os",
      header: "OS",
      cell: ({ row }) => (
        <span className="text-xs text-gray-400 font-mono">{row.original.mdm.os_version || "—"}</span>
      ),
    },
    {
      id: "tc_status",
      header: "TC Status",
      cell: ({ row }) => tcStatusBadge(row.original),
    },
    {
      id: "tc_last_active",
      header: "Last Active",
      cell: ({ row }) => <span className="text-xs text-gray-500">{timeAgo(row.original.tc.last_active)}</span>,
    },
    {
      id: "mdm",
      header: "MDM",
      cell: ({ row }) => enrollmentBadge(row.original.mdm.enrollment_status),
    },
    {
      id: "safari",
      header: "Safari",
      cell: ({ row }) => {
        const s = row.original.mdm.safari_driver;
        return <span className={`text-xs font-mono ${s === "ENABLED" ? "text-emerald-400" : "text-gray-600"}`}>{s || "—"}</span>;
      },
    },
    {
      id: "branch",
      header: "Branch",
      cell: ({ row }) => {
        const b = row.original.mdm.branch;
        return <span className={`text-xs font-mono ${b ? "text-amber-400" : "text-gray-700"}`}>{b || "—"}</span>;
      },
    },
    {
      id: "git_version",
      header: "Git",
      cell: ({ row }) => {
        const g = row.original.mdm.git_version;
        return <span className="text-xs font-mono text-gray-400">{g || "—"}</span>;
      },
    },
  ];

  const table = useReactTable({
    data: workers,
    columns,
    state: { sorting },
    onSortingChange: (updater) => { setPage(0); setSorting(updater); },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
  });

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="p-8 space-y-5 max-w-[1400px]">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white tracking-tight">Workers</h1>
          <p className="text-gray-500 text-sm mt-0.5">{total.toLocaleString()} workers total</p>
        </div>
      </div>

      {/* Quick pool filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold">Prod</span>
          {[
            { name: "gecko-t-osx-1400-r8", short: "1400-r8" },
            { name: "gecko-t-osx-1015-r8", short: "1015-r8" },
            { name: "gecko-t-osx-1500-m4", short: "1500-m4" },
          ].map(p => (
            <button
              key={p.name}
              onClick={() => setFilter("worker_pool", pool === p.name ? "" : p.name)}
              className={`text-xs font-mono px-2.5 py-1 rounded-md border transition-all ${
                pool === p.name
                  ? "bg-brand-500/20 border-brand-500/60 text-brand-300"
                  : "bg-gray-800/60 border-gray-700/50 text-gray-400 hover:text-gray-200 hover:border-gray-600"
              }`}
            >
              {p.short}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold">Linux</span>
          {[
            { name: "gecko-t-linux-talos-2404", short: "talos-2404" },
            { name: "gecko-t-linux-talos-1804", short: "talos-1804" },
            { name: "gecko-t-linux-netperf-2404", short: "netperf" },
          ].map(p => (
            <button key={p.name} onClick={() => setFilter("worker_pool", pool === p.name ? "" : p.name)}
              className={`text-xs font-mono px-2.5 py-1 rounded-md border transition-all ${
                pool === p.name
                  ? "bg-teal-500/20 border-teal-500/60 text-teal-300"
                  : "bg-gray-800/60 border-gray-700/50 text-gray-400 hover:text-gray-200 hover:border-gray-600"
              }`}>{p.short}</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold">Staging</span>
          {[
            { name: "gecko-t-osx-1400-r8-staging", short: "1400-r8" },
            { name: "gecko-t-osx-1015-r8-staging", short: "1015-r8" },
            { name: "gecko-t-osx-1500-m4-staging", short: "1500-m4" },
          ].map(p => (
            <button
              key={p.name}
              onClick={() => setFilter("worker_pool", pool === p.name ? "" : p.name)}
              className={`text-xs font-mono px-2.5 py-1 rounded-md border transition-all ${
                pool === p.name
                  ? "bg-blue-500/20 border-blue-500/60 text-blue-300"
                  : "bg-gray-800/60 border-gray-700/50 text-gray-400 hover:text-gray-200 hover:border-gray-600"
              }`}
            >
              {p.short}
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-52">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
          <input
            className="w-full bg-gray-900/80 border border-gray-800 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500/60 focus:border-brand-500/40 transition-all"
            placeholder="Search hostname or serial…"
            value={search}
            onChange={e => setFilter("search", e.target.value)}
          />
        </div>
        {[
          { key: "generation", label: "Generation", opts: ["r8", "m2", "m4"] },
          { key: "state", label: "State", opts: ["production", "staging", "loaner", "defective", "spare"] },
        ].map(({ key, label, opts }) => (
          <select
            key={key}
            className="bg-gray-900/80 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500/60 focus:border-brand-500/40 transition-all"
            value={key === "generation" ? generation : state}
            onChange={e => setFilter(key, e.target.value)}
          >
            <option value="">All {label}s</option>
            {opts.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ))}
        <select
          className="bg-gray-900/80 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500/60 focus:border-brand-500/40 transition-all max-w-[220px]"
          value={pool}
          onChange={e => setFilter("worker_pool", e.target.value)}
        >
          <option value="">All Pools</option>
          {poolOptions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        {hasFilters && (
          <button
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-200 bg-gray-800/60 hover:bg-gray-800 px-3 py-2 rounded-lg transition-all border border-gray-700/50"
            onClick={() => { setSearchParams({}); setPage(0); }}
          >
            <X size={11} /> Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {error && <div className="px-4 py-3 text-red-400 text-xs border-b border-gray-800">{error}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              {table.getHeaderGroups().map(hg => (
                <tr key={hg.id} className="border-b border-gray-800/80">
                  {hg.headers.map(header => (
                    <th
                      key={header.id}
                      className="text-left px-4 py-3 text-[11px] font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-gray-300 transition-colors"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() === "asc" ? (
                          <ArrowUp size={9} className="text-brand-400" />
                        ) : header.column.getIsSorted() === "desc" ? (
                          <ArrowDown size={9} className="text-brand-400" />
                        ) : (
                          <ArrowUpDown size={9} className="opacity-20" />
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-12 text-center">
                    <div className="flex items-center justify-center gap-2 text-gray-600 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
                      Loading…
                    </div>
                  </td>
                </tr>
              ) : table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-12 text-center text-gray-600 text-sm">
                    No workers found
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map(row => {
                  const isQuarantined = row.original.tc.quarantined;
                  const isDefective = row.original.state === "defective";
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-gray-800/40 hover:bg-gray-800/20 cursor-pointer transition-colors group relative ${isQuarantined || isDefective ? "bg-red-950/10" : ""}`}
                      onClick={() => navigate(`/workers/${row.original.hostname}`)}
                    >
                      {row.getVisibleCells().map(cell => (
                        <td key={cell.id} className="px-4 py-2">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800/60">
          <span className="text-xs text-gray-600">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <button
              className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-600 hover:text-gray-200 disabled:opacity-20 transition-all"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-gray-500 px-2 tabular-nums">
              {page + 1} / {totalPages}
            </span>
            <button
              className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-600 hover:text-gray-200 disabled:opacity-20 transition-all"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
