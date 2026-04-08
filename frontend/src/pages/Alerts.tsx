import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Eye, Pencil, X } from "lucide-react";
import { api } from "../api";
import type { Alert } from "../api";
import { Badge } from "../components/Badge";

const TYPE_LABELS: Record<string, { label: string; color: "red" | "orange" | "yellow" | "gray" }> = {
  missing_from_tc:  { label: "Missing from TC",   color: "red" },
  quarantined:      { label: "Quarantined",        color: "orange" },
  mdm_unenrolled:   { label: "MDM Unenrolled",     color: "yellow" },
  pool_mismatch:    { label: "Pool Mismatch",      color: "gray" },
};

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.round(diff / 36e5);
  if (hrs < 1) return "<1h ago";
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function NoteCell({ hostname, initialNote, onSaved }: { hostname: string; initialNote: string | null; onSaved: (note: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialNote || "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function startEdit() {
    setValue(initialNote || "");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function save() {
    setSaving(true);
    try {
      const updated = await api.workers.updateNotes(hostname, value.trim() || null);
      onSaved(updated.dashboard_notes);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === "Escape") { setEditing(false); }
  }

  if (editing) {
    return (
      <div className="flex items-start gap-1 min-w-[180px]">
        <textarea
          ref={inputRef}
          className="flex-1 bg-gray-800 border border-brand-500 rounded px-2 py-1 text-xs text-white resize-none focus:outline-none"
          rows={2}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Add a note… (Enter to save)"
        />
        <div className="flex flex-col gap-1">
          <button onClick={save} disabled={saving} className="p-1 rounded hover:bg-gray-700 text-emerald-400 hover:text-emerald-300 disabled:opacity-50" title="Save">
            <CheckCircle2 size={13} />
          </button>
          <button onClick={() => setEditing(false)} className="p-1 rounded hover:bg-gray-700 text-gray-500 hover:text-gray-300" title="Cancel">
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={startEdit}
      className="flex items-center gap-1.5 text-left group"
      title="Edit note"
    >
      {initialNote
        ? <span className="text-xs text-amber-300 max-w-[180px] line-clamp-2">{initialNote}</span>
        : <span className="text-xs text-gray-600 group-hover:text-gray-400">add note…</span>
      }
      <Pencil size={11} className="text-gray-600 group-hover:text-gray-400 flex-shrink-0" />
    </button>
  );
}

function isSigningWorker(alert: Alert) {
  if (!alert.hostname.startsWith("macmini-")) return true;
  if (alert.worker?.worker_pool?.includes("signing")) return true;
  return false;
}

export function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeOnly, setActiveOnly] = useState(true);
  const [hideSigningWorkers, setHideSigningWorkers] = useState(true);
  // hostname → dashboard_notes (local overrides after edits)
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    try {
      const data = await api.alerts.list(activeOnly);
      setAlerts(data.alerts);
      setTotal(data.total);
      // Pre-populate notes from worker data
      const initialNotes: Record<string, string | null> = {};
      for (const a of data.alerts) {
        if (a.worker && "dashboard_notes" in a.worker) {
          initialNotes[a.hostname] = (a.worker as any).dashboard_notes ?? null;
        }
      }
      setNotes(initialNotes);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [activeOnly]);

  async function resolve(id: number) {
    await api.alerts.resolve(id);
    setAlerts(prev => prev.filter(a => a.id !== id));
    setTotal(t => t - 1);
  }

  async function acknowledge(id: number) {
    await api.alerts.acknowledge(id);
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged: true } : a));
  }

  const visibleAlerts = hideSigningWorkers
    ? alerts.filter(a => !isSigningWorker(a))
    : alerts;

  const byType = visibleAlerts.reduce<Record<string, number>>((acc, a) => {
    acc[a.alert_type] = (acc[a.alert_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <AlertTriangle size={22} className="text-red-400" /> Alerts
          </h1>
          <p className="text-gray-400 text-sm mt-1">
            {visibleAlerts.length}{total !== visibleAlerts.length ? ` of ${total}` : ""} {activeOnly ? "active" : "total"} alerts
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" checked={hideSigningWorkers} onChange={e => setHideSigningWorkers(e.target.checked)} className="accent-brand-500" />
            Hide signing workers
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="accent-brand-500" />
            Active only
          </label>
        </div>
      </div>

      {/* Summary by type */}
      {Object.keys(byType).length > 0 && (
        <div className="flex flex-wrap gap-3">
          {Object.entries(byType).map(([type, count]) => {
            const cfg = TYPE_LABELS[type] || { label: type, color: "gray" as const };
            return (
              <div key={type} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-3">
                <Badge label={cfg.label} variant={cfg.color} />
                <span className="text-2xl font-bold text-white">{count}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Alert list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : visibleAlerts.length === 0 ? (
          <div className="p-12 text-center">
            <CheckCircle2 size={40} className="text-emerald-400 mx-auto mb-3" />
            <div className="text-lg font-medium text-gray-300">All clear!</div>
            <div className="text-sm text-gray-500 mt-1">No active alerts</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {["Type", "Worker", "Pool", "Detail", "Notes", "Since", "Actions"].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleAlerts.map(alert => {
                const cfg = TYPE_LABELS[alert.alert_type] || { label: alert.alert_type, color: "gray" as const };
                return (
                  <tr key={alert.id} className={`border-b border-gray-800/50 ${alert.acknowledged ? "opacity-60" : ""}`}>
                    <td className="px-4 py-3">
                      <Badge label={cfg.label} variant={cfg.color} />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        className="text-brand-400 hover:text-brand-300 font-mono text-xs block"
                        onClick={() => navigate(`/workers/${alert.hostname}`)}
                      >
                        {alert.hostname.split(".")[0]}
                      </button>
                      {alert.worker?.generation && (
                        <span className="text-xs text-gray-500">{alert.worker.generation}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                      {alert.worker?.worker_pool?.replace(/^gecko-t-osx-\d+-/, "") || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{alert.detail || "—"}</td>
                    <td className="px-4 py-2">
                      <NoteCell
                        hostname={alert.hostname}
                        initialNote={notes[alert.hostname] ?? alert.worker?.dashboard_notes ?? null}
                        onSaved={note => setNotes(prev => ({ ...prev, [alert.hostname]: note }))}
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{timeAgo(alert.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {!alert.acknowledged && (
                          <button
                            className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-white"
                            title="Acknowledge"
                            onClick={() => acknowledge(alert.id)}
                          >
                            <Eye size={14} />
                          </button>
                        )}
                        <button
                          className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-emerald-400"
                          title="Resolve"
                          onClick={() => resolve(alert.id)}
                        >
                          <CheckCircle2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
