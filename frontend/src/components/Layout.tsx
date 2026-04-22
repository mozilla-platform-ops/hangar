import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, Monitor, AlertTriangle, BarChart2, RefreshCw, Layers, ChevronDown, Smartphone, Terminal, Apple, Menu, X } from "lucide-react";
import { clsx } from "clsx";
import { useState, useEffect } from "react";
import { api } from "../api";

function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

const NAV = [
  { to: "/", icon: LayoutDashboard, label: "Overview" },
  { to: "/workers", icon: Monitor, label: "Workers" },
  { to: "/alerts", icon: AlertTriangle, label: "Alerts" },
  { to: "/consolidation", icon: BarChart2, label: "Consolidation" },
];

const POOL_SECTIONS = [
  { section: "",        label: "Overview",  icon: Layers },
  { section: "mac",     label: "macOS",     icon: Apple },
  { section: "linux",   label: "Linux",     icon: Terminal },
  { section: "android", label: "Android",   icon: Smartphone },
];

export function Layout() {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [tcSync, setTcSync] = useState<{ last_success: string | null } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    api.fleet.summary()
      .then(d => setTcSync(d.sync_status["taskcluster"] ?? null))
      .catch(() => {});
  }, []);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, location.search]);
  const onPools = location.pathname.startsWith("/pools");
  const currentSection = new URLSearchParams(location.search).get("section") ?? "";

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
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-gray-950/70 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          "fixed md:relative inset-y-0 left-0 z-30 w-56 flex-shrink-0 flex flex-col border-r border-gray-800/80 transition-transform duration-200 ease-in-out",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}
        style={{ background: "linear-gradient(180deg, #0f1117 0%, #0d1117 100%)" }}>

        {/* Brand */}
        <div className="px-4 py-5 border-b border-gray-800/60">
          <div className="flex items-center gap-2.5">
            <svg viewBox="0 0 48 32" width="36" height="24" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
              <path d="M3,26 Q14,5 45,13 Q31,17 29,26 Z" fill="#378ADD"/>
              <path d="M3,26 Q14,8 45,13 Q36,11 34,20 Z" fill="#85B7EB"/>
            </svg>
            <div className="flex-1">
              <div className="text-base font-medium text-brand-500 leading-none tracking-tight">Hangar</div>
              <div className="text-[10px] font-mono text-gray-600 leading-none mt-1 tracking-wide">CI FLEET MANAGER</div>
            </div>
            <button
              className="md:hidden p-1 text-gray-600 hover:text-gray-300 transition-colors"
              onClick={() => setSidebarOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.slice(0, 2).map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === "/"}
              className={({ isActive }) => clsx(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 relative",
                isActive ? "bg-brand-500/10 text-brand-300 border border-brand-500/20"
                         : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent"
              )}>
              {({ isActive }) => (<>
                {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-brand-400 rounded-full" />}
                <Icon size={15} />{label}
              </>)}
            </NavLink>
          ))}

          {/* Pool Health with sub-nav */}
          <div>
            <button onClick={() => navigate("/pools")}
              className={clsx(
                "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 relative",
                onPools ? "bg-brand-500/10 text-brand-300 border border-brand-500/20"
                        : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent"
              )}>
              {onPools && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-brand-400 rounded-full" />}
              <Layers size={15} />
              <span className="flex-1 text-left">Pool Health</span>
              <ChevronDown size={11} className={clsx("transition-transform text-gray-600", onPools && "rotate-180")} />
            </button>
            {onPools && (
              <div className="mt-0.5 ml-3 pl-3 border-l border-gray-800 space-y-0.5">
                {POOL_SECTIONS.map(({ section, label, icon: Icon }) => {
                  const isActive = currentSection === section;
                  const to = section ? `/pools?section=${section}` : "/pools";
                  return (
                    <button key={section} onClick={() => navigate(to)}
                      className={clsx(
                        "w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all",
                        isActive ? "bg-brand-500/10 text-brand-300" : "text-gray-600 hover:text-gray-300 hover:bg-gray-800/40"
                      )}>
                      <Icon size={11} />{label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {NAV.slice(2).map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) => clsx(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 relative",
                isActive ? "bg-brand-500/10 text-brand-300 border border-brand-500/20"
                         : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent"
              )}>
              {({ isActive }) => (<>
                {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-brand-400 rounded-full" />}
                <Icon size={15} />{label}
              </>)}
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
            <div className="flex flex-col items-start gap-0.5">
              <span>{syncing ? "Syncing…" : syncMsg || "Sync All Sources"}</span>
              {!syncing && !syncMsg && tcSync?.last_success && (
                <span className="text-[10px] text-gray-700 font-normal">TC {timeAgo(tcSync.last_success)}</span>
              )}
            </div>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto flex flex-col min-w-0">
        {/* Mobile top bar */}
        <div className="md:hidden sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-gray-800/60 bg-gray-950/90 backdrop-blur-sm flex-shrink-0">
          <button
            className="p-1.5 -ml-1 text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 rounded-lg transition-colors"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={20} />
          </button>
          <svg viewBox="0 0 48 32" width="28" height="18" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
            <path d="M3,26 Q14,5 45,13 Q31,17 29,26 Z" fill="#378ADD"/>
            <path d="M3,26 Q14,8 45,13 Q36,11 34,20 Z" fill="#85B7EB"/>
          </svg>
          <span className="text-sm font-medium text-brand-400 tracking-tight">Hangar</span>
        </div>
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
