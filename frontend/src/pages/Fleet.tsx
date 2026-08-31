import { useSearchParams } from "react-router-dom";
import { Grid3x3, Table2 } from "lucide-react";
import { FF_GRADIENT } from "../lib/brand";
import { FleetMapView } from "./Heatmap";
import { WorkersTableView } from "./Workers";

type View = "map" | "table";

/** Unified Fleet destination: a health heatmap and the searchable worker
 *  inventory as two tabs of one page. View is in the URL (?view=) so it's
 *  shareable and survives refresh; table filters live in the URL too, so they
 *  persist across a toggle. */
export function Fleet() {
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "table" ? "table" : "map";

  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    next.set("view", v);
    setParams(next, { replace: true });
  };

  const tabs: Array<{ key: View; label: string; icon: typeof Grid3x3 }> = [
    { key: "map", label: "Map", icon: Grid3x3 },
    { key: "table", label: "Table", icon: Table2 },
  ];

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <span className="w-1 h-9 rounded-full flex-shrink-0" style={{ backgroundImage: FF_GRADIENT }} />
          <div>
            <h1 className="text-2xl font-light text-white tracking-tight">Fleet</h1>
            <p className="text-gray-500 text-sm mt-0.5">{view === "map" ? "health at a glance" : "search & audit"}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-0.5">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setView(key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${
                view === key ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
              }`}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === "map" ? <FleetMapView /> : <WorkersTableView />}
    </div>
  );
}
