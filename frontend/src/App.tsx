import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { Overview } from "./pages/Overview";
import { Workers } from "./pages/Workers";
import { WorkerDetail } from "./pages/WorkerDetail";
import { Alerts } from "./pages/Alerts";
import { Consolidation } from "./pages/Consolidation";
import { Pools } from "./pages/Pools";

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
          <Route path="consolidation" element={<Consolidation />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
