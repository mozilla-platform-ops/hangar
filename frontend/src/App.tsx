import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Overview } from "./pages/Overview";
import { Workers } from "./pages/Workers";
import { WorkerDetail } from "./pages/WorkerDetail";
import { Alerts } from "./pages/Alerts";
import { Consolidation } from "./pages/Consolidation";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="workers" element={<Workers />} />
          <Route path="workers/:hostname" element={<WorkerDetail />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="consolidation" element={<Consolidation />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
