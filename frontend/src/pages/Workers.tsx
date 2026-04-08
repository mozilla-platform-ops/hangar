import { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel,
  flexRender,
} from "@tanstack/react-table";
import type { SortingState, ColumnDef } from "@tanstack/react-table";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../api";
import type { Worker } from "../api";
import { stateBadge, tcStatusBadge, enrollmentBadge } from "../components/Badge";

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

  // Filter state from URL
  const search = searchParams.get("search") || "";
  const generation = searchParams.get("generation") || "";
  const state = searchParams.get("state") || "";
  const pool = searchParams.get("worker_pool") || "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.workers.list({
        search: search || undefined,
        generation: generation || undefined,
        state: state || undefined,
        worker_pool: pool || undefined,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      setWorkers(result.workers);
      setTotal(result.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, generation, state, pool, page]);

  useEffect(() => { load(); }, [load]);

  function setFilter(key: string, val: string) {
    setPage(0);
    const next = new URLSearchParams(searchParams);
    if (val) next.set(key, val); else next.delete(key);
    setSearchParams(next);
  }

  const columns: ColumnDef<Worker>[] = [
    {
      accessorKey: "hostname",
      header: "Hostname",
      cell: ({ row }) => (
        <button
          className="text-brand-400 hover:text-brand-300 font-mono text-xs truncate max-w-[180px] block"
          onClick={() => navigate(`/workers/${row.original.hostname}`)}
        >
          {row.original.worker_id || row.original.hostname.split(".")[0]}
        </button>
      ),
    },
    {
      accessorKey: "generation",
      header: "Gen",
      cell: ({ getValue }) => <span className="text-xs text-gray-300">{getValue() as string || "?"}</span>,
    },
    {
      accessorKey: "worker_pool",
      header: "Pool",
      cell: ({ getValue }) => <span className="text-xs text-gray-300 font-mono truncate max-w-[160px] block">{getValue() as string || "—"}</span>,
    },
    {
      id: "state",
      header: "State",
      cell: ({ row }) => stateBadge(row.original.state),
    },
    {
      id: "os",
      header: "OS",
      cell: ({ row }) => <span className="text-xs text-gray-300">{row.original.mdm.os_version || "—"}</span>,
    },
    {
      id: "tc_status",
      header: "TC Status",
      cell: ({ row }) => tcStatusBadge(row.original),
    },
    {
      id: "tc_last_active",
      header: "Last Active",
      cell: ({ row }) => <span className="text-xs text-gray-400">{timeAgo(row.original.tc.last_active)}</span>,
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
        return <span className={`text-xs ${s === "ENABLED" ? "text-emerald-400" : "text-gray-500"}`}>{s || "—"}</span>;
      },
    },
  ];

  const table = useReactTable({
    data: workers,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    manualPagination: true,
    manualFiltering: true,
  });

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="p-8 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Workers</h1>
          <p className="text-gray-400 text-sm mt-1">{total} total workers</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
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
            className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={key === "generation" ? generation : state}
            onChange={e => setFilter(key, e.target.value)}
          >
            <option value="">All {label}s</option>
            {opts.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ))}
        {(search || generation || state || pool) && (
          <button
            className="text-xs text-gray-400 hover:text-white underline"
            onClick={() => { setSearchParams({}); setPage(0); }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {error && <div className="p-4 text-red-400 text-sm">{error}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              {table.getHeaderGroups().map(hg => (
                <tr key={hg.id} className="border-b border-gray-800">
                  {hg.headers.map(header => (
                    <th
                      key={header.id}
                      className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-white"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() === "asc" ? <ArrowUp size={10} /> :
                         header.column.getIsSorted() === "desc" ? <ArrowDown size={10} /> :
                         <ArrowUpDown size={10} className="opacity-30" />}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={columns.length} className="px-4 py-8 text-center text-gray-500">Loading…</td></tr>
              ) : table.getRowModel().rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-4 py-8 text-center text-gray-500">No workers found</td></tr>
              ) : (
                table.getRowModel().rows.map(row => (
                  <tr
                    key={row.id}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer transition-colors"
                    onClick={() => navigate(`/workers/${row.original.hostname}`)}
                  >
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id} className="px-4 py-2.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
          <span className="text-xs text-gray-500">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white disabled:opacity-30"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-gray-400 px-2">Page {page + 1} / {totalPages}</span>
            <button
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white disabled:opacity-30"
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
