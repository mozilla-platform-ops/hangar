import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Monitor, Layers } from "lucide-react";
import { api } from "../api";
import type { Worker, PoolHealth } from "../api";
import { stateBadge } from "./Badge";

type Item =
  | { kind: "worker"; worker: Worker }
  | { kind: "pool"; pool: PoolHealth };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [allPools, setAllPools] = useState<PoolHealth[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const poolsLoaded = useRef(false);
  useEffect(() => {
    if (open && !poolsLoaded.current) {
      poolsLoaded.current = true;
      api.fleet.pools().then(r => setAllPools(r.pools)).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(prev => {
          if (!prev) { setQuery(""); setWorkers([]); setSelected(0); }
          return !prev;
        });
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!query.trim()) { setWorkers([]); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      api.workers.list({ search: query.trim(), limit: 6 })
        .then(r => { setWorkers(r.workers); setSelected(0); })
        .catch(() => setWorkers([]))
        .finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const q = query.trim().toLowerCase();
  const matchedPools = q ? allPools.filter(p => p.name.toLowerCase().includes(q)).slice(0, 4) : [];

  const items: Item[] = [
    ...matchedPools.map(p => ({ kind: "pool" as const, pool: p })),
    ...workers.map(w => ({ kind: "worker" as const, worker: w })),
  ];

  function go(item: Item) {
    if (item.kind === "pool") {
      navigate(`/workers?worker_pool=${encodeURIComponent(item.pool.name)}`);
    } else {
      navigate(`/workers/${encodeURIComponent(item.worker.hostname)}`);
    }
    setOpen(false);
    setQuery("");
    setWorkers([]);
  }

  if (!open) return null;

  const showPoolHeader = matchedPools.length > 0;
  const showWorkerHeader = workers.length > 0;
  const showBothHeaders = showPoolHeader && showWorkerHeader;
  let flatIdx = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg bg-gray-900 border border-gray-700/80 rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-800">
          <Search size={14} className="text-gray-500 flex-shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none"
            placeholder="Jump to worker or pool…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.min(s + 1, items.length - 1)); }
              if (e.key === "ArrowUp")   { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && items[selected]) go(items[selected]);
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <kbd className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded font-mono">esc</kbd>
        </div>

        {items.length > 0 && (
          <ul className="max-h-80 overflow-y-auto py-1">
            {showPoolHeader && (
              <>
                {showBothHeaders && (
                  <li className="px-4 py-1.5 text-[10px] font-semibold text-gray-600 uppercase tracking-wider flex items-center gap-1.5">
                    <Layers size={9} /> Pools
                  </li>
                )}
                {matchedPools.map(pool => {
                  const idx = flatIdx++;
                  return (
                    <li
                      key={pool.name}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${idx === selected ? "bg-brand-900/40" : "hover:bg-gray-800/40"}`}
                      onClick={() => go({ kind: "pool", pool })}
                      onMouseEnter={() => setSelected(idx)}
                    >
                      <Layers size={11} className="text-gray-600 flex-shrink-0" />
                      <span className="font-mono text-xs text-white">{pool.name}</span>
                      <span className="ml-auto text-[10px] text-gray-600 tabular-nums">{pool.total} workers</span>
                    </li>
                  );
                })}
              </>
            )}
            {showWorkerHeader && (
              <>
                {showBothHeaders && (
                  <li className="px-4 py-1.5 text-[10px] font-semibold text-gray-600 uppercase tracking-wider flex items-center gap-1.5 mt-1 border-t border-gray-800/60 pt-2">
                    <Monitor size={9} /> Workers
                  </li>
                )}
                {workers.map(w => {
                  const idx = flatIdx++;
                  return (
                    <li
                      key={w.hostname}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${idx === selected ? "bg-brand-900/40" : "hover:bg-gray-800/40"}`}
                      onClick={() => go({ kind: "worker", worker: w })}
                      onMouseEnter={() => setSelected(idx)}
                    >
                      <Monitor size={11} className="text-gray-600 flex-shrink-0" />
                      <span className="font-mono text-xs text-white">{w.hostname.split(".")[0]}</span>
                      {w.worker_pool && (
                        <span className="text-[10px] text-gray-600 font-mono truncate">{w.worker_pool}</span>
                      )}
                      <span className="ml-auto">{stateBadge(w.state)}</span>
                    </li>
                  );
                })}
              </>
            )}
          </ul>
        )}

        {q && !loading && items.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-gray-600">No results</div>
        )}

        {!q && (
          <div className="px-4 py-3 text-[10px] text-gray-700 flex items-center gap-4">
            <span><kbd className="bg-gray-800 px-1 rounded font-mono">↑↓</kbd> navigate</span>
            <span><kbd className="bg-gray-800 px-1 rounded font-mono">↵</kbd> open</span>
            <span><kbd className="bg-gray-800 px-1 rounded font-mono">esc</kbd> close</span>
          </div>
        )}
      </div>
    </div>
  );
}
