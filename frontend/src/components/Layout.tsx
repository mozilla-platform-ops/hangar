import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Monitor, AlertTriangle, BarChart2, RefreshCw, Layers } from "lucide-react";
import { clsx } from "clsx";
import { useState } from "react";
import { api } from "../api";

const NAV = [
  { to: "/", icon: LayoutDashboard, label: "Overview" },
  { to: "/workers", icon: Monitor, label: "Workers" },
  { to: "/pools", icon: Layers, label: "Pool Health" },
  { to: "/alerts", icon: AlertTriangle, label: "Alerts" },
  { to: "/consolidation", icon: BarChart2, label: "Consolidation" },
];

export function Layout() {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  async function triggerSync() {
    setSyncing(true);
    setSyncMsg("");
    try {
      await api.sync.run();
      setSyncMsg("Sync started!");
    } catch {
      setSyncMsg("Failed");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(""), 3000);
    }
  }

  return (
    <div className="flex h-screen bg-gray-950">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r border-gray-800/80"
        style={{ background: "linear-gradient(180deg, #0f1117 0%, #0d1117 100%)" }}>

        {/* Brand */}
        <div className="px-4 py-5 border-b border-gray-800/60">
          <div className="flex items-center gap-2.5">
            <svg viewBox="0 0 48 32" width="36" height="24" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
              <path d="M3,26 Q14,5 45,13 Q31,17 29,26 Z" fill="#378ADD"/>
              <path d="M3,26 Q14,8 45,13 Q36,11 34,20 Z" fill="#85B7EB"/>
            </svg>
            <div>
              <div className="text-base font-medium text-brand-500 leading-none tracking-tight">Hangar</div>
              <div className="text-[10px] font-mono text-gray-600 leading-none mt-1 tracking-wide">CI FLEET MANAGER</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 relative",
                  isActive
                    ? "bg-brand-500/10 text-brand-300 border border-brand-500/20"
                    : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent"
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-brand-400 rounded-full" />
                  )}
                  <Icon size={15} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Sync */}
        <div className="px-3 pb-4 border-t border-gray-800/60 pt-3">
          <button
            onClick={triggerSync}
            disabled={syncing}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 transition-all disabled:opacity-40 border border-transparent hover:border-gray-700/50"
          >
            <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing…" : syncMsg || "Sync All Sources"}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
