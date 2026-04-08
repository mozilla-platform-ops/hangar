import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Monitor, AlertTriangle, BarChart2, RefreshCw } from "lucide-react";
import { clsx } from "clsx";
import { useState } from "react";
import { api } from "../api";

const NAV = [
  { to: "/", icon: LayoutDashboard, label: "Overview" },
  { to: "/workers", icon: Monitor, label: "Workers" },
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
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-5 py-5 border-b border-gray-800">
          <div className="text-sm font-semibold text-brand-500 uppercase tracking-widest">RelOps</div>
          <div className="text-lg font-bold text-white mt-0.5">Fleet Dashboard</div>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-0.5">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                clsx("flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-brand-500/20 text-brand-400"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                )
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-3 pb-4">
          <button
            onClick={triggerSync}
            disabled={syncing}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing…" : syncMsg || "Sync All"}
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
