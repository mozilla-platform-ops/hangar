import { lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { ReprovisionNotifier } from "./components/ReprovisionNotifier";

// Route-level code splitting: each page loads on first visit, so the initial
// bundle is just the shell + the landing page.
const Overview = lazy(() => import("./pages/Overview").then(m => ({ default: m.Overview })));
const Fleet = lazy(() => import("./pages/Fleet").then(m => ({ default: m.Fleet })));
const WorkerDetail = lazy(() => import("./pages/WorkerDetail").then(m => ({ default: m.WorkerDetail })));
const Alerts = lazy(() => import("./pages/Alerts").then(m => ({ default: m.Alerts })));
const FailureInsights = lazy(() => import("./pages/FailureInsights").then(m => ({ default: m.FailureInsights })));
const Pools = lazy(() => import("./pages/Pools").then(m => ({ default: m.Pools })));
const TartVMs = lazy(() => import("./pages/TartVMs").then(m => ({ default: m.TartVMs })));

/** Redirect a legacy path onto /fleet while PRESERVING the incoming query string
 * (so /workers?worker_pool=… keeps its filter instead of landing on the full table). */
function RedirectToFleet({ view }: { view: "map" | "table" }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("view", view);
  return <Navigate to={`/fleet?${params.toString()}`} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <CommandPalette />
      <KeyboardShortcuts />
      <ReprovisionNotifier />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="fleet" element={<Fleet />} />
          {/* Fleet Map and Workers merged into /fleet — keep old links working. */}
          <Route path="map" element={<RedirectToFleet view="map" />} />
          <Route path="workers" element={<RedirectToFleet view="table" />} />
          <Route path="workers/:hostname" element={<WorkerDetail />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="insights" element={<FailureInsights />} />
          <Route path="pools" element={<Pools />} />
          <Route path="tart-vms" element={<TartVMs />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
