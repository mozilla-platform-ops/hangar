import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, Monitor, AlertTriangle, RefreshCw, Smartphone, Terminal, Apple, Menu, X, Laptop, Grid3x3 } from "lucide-react";
import { clsx } from "clsx";
import { Suspense, useState, useEffect, useId } from "react";
import { api } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { isSigningWorker } from "../lib/alerts";
import { setFavicon } from "../lib/favicon";
import { usePoll, useNow } from "../lib/useLive";

// Hangar mark — a paper-plane dart filled with the Firefox gradient, matching the
// Overview accents. useId keeps the gradient unique per instance (the sidebar and
// mobile-bar logos both live in the DOM at once).
function HangarLogo({ size = 34 }: { size?: number }) {
  const gid = useId();
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className="flex-shrink-0" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FF9400" />
          <stop offset="50%" stopColor="#FF1AD9" />
          <stop offset="100%" stopColor="#9059FF" />
        </linearGradient>
      </defs>
      {/* Gradient dart with a shaded underside facet for a folded-paper look. */}
      <path d="M22 2 15 22 11 13 2 9Z" fill={`url(#${gid})`} />
      <path d="M22 2 11 13 2 9Z" fill="#000" opacity="0.22" />
    </svg>
  );
}

const Wordmark = ({ className = "text-base" }: { className?: string }) => (
  <span className={`${className} font-semibold leading-none tracking-tight bg-clip-text text-transparent`}
    style={{ backgroundImage: FF_GRADIENT }}>Hangar</span>
);

function timeAgo(iso: string | null, now = Date.now()) {
  if (!iso) return "never";
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

const POOL_SECTIONS = [
  { section: "android", label: "Android",  icon: Smartphone },
  { section: "linux",   label: "Linux",    icon: Terminal },
  { section: "mac",     label: "macOS",    icon: Apple },
  { section: "windows", label: "Windows",  icon: Laptop },
];

// Shared styling for sidebar items (NavLink anchors and query-param pool buttons alike).
const navItemClass = (active: boolean) => clsx(
  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 relative",
  active ? "bg-brand-500/10 text-brand-300 border border-brand-500/20"
         : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent"
);
const ActiveBar = () => <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-brand-400 rounded-full" />;

// A top-level sidebar link with the active accent bar and an optional count badge.
function NavLinkItem({ to, icon: Icon, label, end, badge }: { to: string; icon: typeof Monitor; label: string; end?: boolean; badge?: number }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => navItemClass(isActive)}>
      {({ isActive }) => (
        <>
          {isActive && <ActiveBar />}
          <Icon size={15} />{label}
          {badge ? (
            <span className="ml-auto text-[10px] font-semibold tabular-nums leading-none bg-red-500/15 text-red-400 border border-red-500/30 rounded-full px-1.5 py-0.5">
              {badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

// Small grouping label between nav sections.
function SectionLabel({ children }: { children: string }) {
  return <div className="px-3 pt-4 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-600">{children}</div>;
}

export function Layout() {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [tcSync, setTcSync] = useState<{ last_success: string | null } | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const now = useNow(30_000);

  const refreshShell = () => {
    api.fleet.summary()
      .then(d => setTcSync(d.sync_status["taskcluster"] ?? null))
      .catch(() => {});
    api.alerts.list(true)
      .then(d => setAlertCount(d.alerts.filter(a => !isSigningWorker(a)).length))
      .catch(() => {});
  };
  useEffect(refreshShell, []);
  usePoll(refreshShell, 60_000);

  // Keep the tab title and favicon static — alerts are surfaced in-app, not in
  // the browser tab.
  useEffect(() => {
    document.title = "Hangar";
    setFavicon(0);
  }, []);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, location.search]);
  const onPools = location.pathname.startsWith("/pools");
  const currentSection = new URLSearchParams(location.search).get("section") || "mac";

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
            <HangarLogo size={32} />
            <div className="flex-1">
              <Wordmark />
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
        <nav className="flex-1 px-2 py-3 overflow-y-auto">
          <NavLinkItem to="/" icon={LayoutDashboard} label="Overview" end />
          <NavLinkItem to="/fleet" icon={Grid3x3} label="Fleet" />

          <SectionLabel>Platforms</SectionLabel>
          <div className="space-y-0.5">
            {POOL_SECTIONS.map(({ section, label, icon: Icon }) => {
              const active = onPools && currentSection === section;
              return (
                <button key={section} onClick={() => navigate(`/pools?section=${section}`)} className={clsx("w-full text-left", navItemClass(active))}>
                  {active && <ActiveBar />}
                  <Icon size={15} />{label}
                </button>
              );
            })}
          </div>

          <SectionLabel>Monitoring</SectionLabel>
          <NavLinkItem to="/alerts" icon={AlertTriangle} label="Alerts" badge={alertCount} />
        </nav>

        {/* Footer — utility */}
        <div className="border-t border-gray-800/60 px-2 pt-2 pb-3 space-y-1">
          <button
            onClick={triggerSync}
            disabled={syncing}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 transition-all disabled:opacity-40 border border-transparent hover:border-gray-700/50"
          >
            <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
            <div className="flex flex-col items-start gap-0.5">
              <span>{syncing ? "Syncing…" : syncMsg || "Sync sources"}</span>
              {!syncing && !syncMsg && tcSync?.last_success && (
                <span className="text-[10px] text-gray-700 font-normal">TC {timeAgo(tcSync.last_success, now)}</span>
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
          <HangarLogo size={24} />
          <Wordmark className="text-sm" />
        </div>
        <div className="flex-1 overflow-auto">
          <Suspense
            fallback={
              <div className="p-8 flex items-center gap-3 text-gray-500 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
                Loading…
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
