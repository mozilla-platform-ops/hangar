import { lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";

// Route-level code splitting: each page loads on first visit, so the initial
// bundle is just the shell + the landing page.
const Overview = lazy(() => import("./pages/Overview").then(m => ({ default: m.Overview })));
const Fleet = lazy(() => import("./pages/Fleet").then(m => ({ default: m.Fleet })));
const WorkerDetail = lazy(() => import("./pages/WorkerDetail").then(m => ({ default: m.WorkerDetail })));
const Alerts = lazy(() => import("./pages/Alerts").then(m => ({ default: m.Alerts })));
const Pools = lazy(() => import("./pages/Pools").then(m => ({ default: m.Pools })));
const TV = lazy(() => import("./pages/TV").then(m => ({ default: m.TV })));

export default function App() {
  return (
    <BrowserRouter>
      <CommandPalette />
      <KeyboardShortcuts />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="fleet" element={<Fleet />} />
          {/* Fleet Map and Workers merged into /fleet — keep old links working. */}
          <Route path="map" element={<Navigate to="/fleet?view=map" replace />} />
          <Route path="workers" element={<Navigate to="/fleet?view=table" replace />} />
          <Route path="workers/:hostname" element={<WorkerDetail />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="pools" element={<Pools />} />
        </Route>
        {/* Chromeless wall-monitor view — no sidebar, lives outside Layout. */}
        <Route path="/tv" element={<TV />} />
      </Routes>
    </BrowserRouter>
  );
}
