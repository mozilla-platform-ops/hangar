import { lazy } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";

// Route-level code splitting: each page loads on first visit, so the initial
// bundle is just the shell + the landing page.
const Overview = lazy(() => import("./pages/Overview").then(m => ({ default: m.Overview })));
const Workers = lazy(() => import("./pages/Workers").then(m => ({ default: m.Workers })));
const WorkerDetail = lazy(() => import("./pages/WorkerDetail").then(m => ({ default: m.WorkerDetail })));
const Alerts = lazy(() => import("./pages/Alerts").then(m => ({ default: m.Alerts })));
const Pools = lazy(() => import("./pages/Pools").then(m => ({ default: m.Pools })));

export default function App() {
  return (
    <BrowserRouter>
      <CommandPalette />
      <KeyboardShortcuts />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="workers" element={<Workers />} />
          <Route path="workers/:hostname" element={<WorkerDetail />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="pools" element={<Pools />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
