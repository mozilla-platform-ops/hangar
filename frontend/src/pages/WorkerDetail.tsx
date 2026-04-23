import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, Terminal, Monitor, Pencil, CheckCircle2, X } from "lucide-react";
import { api } from "../api";
import type { Worker } from "../api";
import { stateBadge, tcStatusBadge, enrollmentBadge } from "../components/Badge";
import { ShellModal } from "../components/ShellModal";
import { VncModal } from "../components/VncModal";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-[0.1em] mb-4">{title}</h3>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4">{children}</div>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <div className="text-[11px] text-gray-600 mb-1 uppercase tracking-wider">{label}</div>
      <div className={`text-sm text-gray-200 ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
    </div>
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString();
}

function InlineNoteEditor({ hostname, initial }: { hostname: string; initial: string | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial || "");
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  function start() { setValue(saved || ""); setEditing(true); setTimeout(() => ref.current?.focus(), 0); }

  async function save() {
    setSaving(true);
    try {
      const w = await api.workers.updateNotes(hostname, value.trim() || null);
      setSaved(w.dashboard_notes);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) return (
    <div className="flex items-start gap-2">
      <textarea
        ref={ref}
        className="flex-1 bg-gray-800/60 border border-brand-500/50 rounded-lg px-3 py-2 text-sm text-white resize-none focus:outline-none focus:ring-1 focus:ring-brand-500/40 font-mono text-xs"
        rows={3}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === "Escape") setEditing(false); }}
        placeholder="Add a note…"
      />
      <div className="flex flex-col gap-1 pt-0.5">
        <button onClick={save} disabled={saving} className="p-1.5 rounded-lg hover:bg-gray-700 text-emerald-400 hover:text-emerald-300 transition-colors" title="Save">
          <CheckCircle2 size={14} />
        </button>
        <button onClick={() => setEditing(false)} className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-600 hover:text-gray-400 transition-colors" title="Cancel">
          <X size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <button onClick={start} className="flex items-center gap-2 text-left group w-full">
      {saved
        ? <span className="text-sm text-amber-300/90 font-mono text-xs">{saved}</span>
        : <span className="text-xs text-gray-700 group-hover:text-gray-500 italic transition-colors">Click to add note…</span>
      }
      <Pencil size={11} className="text-gray-700 group-hover:text-gray-500 flex-shrink-0 transition-colors" />
    </button>
  );
}

export function WorkerDetail() {
  const { hostname = "" } = useParams<{ hostname: string }>();
  const navigate = useNavigate();
  const [worker, setWorker] = useState<Worker | null>(null);
  const [error, setError] = useState("");
  const [showShell, setShowShell] = useState(false);
  const [showVnc, setShowVnc] = useState(false);

  useEffect(() => {
    if (hostname) api.workers.get(hostname).then(setWorker).catch(e => setError(e.message));
  }, [hostname]);

  if (error) return (
    <div className="p-8">
      <button className="flex items-center gap-2 text-sm text-gray-500 hover:text-white mb-6 transition-colors" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>
      <div className="text-red-400 text-sm">{error}</div>
    </div>
  );
  if (!worker) return (
    <div className="p-8 flex items-center gap-2 text-gray-600 text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" /> Loading…
    </div>
  );

  const shortName = worker.worker_id || worker.hostname.split(".")[0];
  const tcUrl = worker.tc.worker_pool_id
    ? `https://firefox-ci-tc.services.mozilla.com/provisioners/releng-hardware/worker-types/${worker.worker_pool}/workers/${worker.tc.worker_group}/${worker.tc.worker_id}`
    : null;

  return (
    <div className="p-8 space-y-5 max-w-5xl">
      {/* Header */}
      <div>
        <button
          className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-300 mb-5 transition-colors"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft size={12} /> Workers
        </button>

        <div className="card p-5">
          <div className="flex items-start gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap mb-1">
                <h1 className="text-xl font-semibold text-white font-mono tracking-tight">{shortName}</h1>
                {stateBadge(worker.state)}
                {tcStatusBadge(worker)}
                {enrollmentBadge(worker.mdm.enrollment_status)}
              </div>
              <p className="text-xs text-gray-600 font-mono">{worker.hostname}</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setShowShell(true)}
                className="flex items-center gap-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700/80 text-gray-300 hover:text-white rounded-lg px-3 py-1.5 transition-all"
              >
                <Terminal size={12} /> Shell
              </button>
              <button
                onClick={() => setShowVnc(true)}
                className="flex items-center gap-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700/80 text-gray-300 hover:text-white rounded-lg px-3 py-1.5 transition-all"
              >
                <Monitor size={12} /> VNC
              </button>
              {tcUrl && (
                <a
                  href={tcUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-xs bg-brand-900/40 hover:bg-brand-900/60 border border-brand-800/50 text-brand-400 hover:text-brand-300 rounded-lg px-3 py-1.5 transition-all"
                >
                  Taskcluster <ExternalLink size={10} />
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <Section title="Identity">
        <Field label="Generation" value={worker.generation} />
        <Field label="Worker Pool" value={worker.worker_pool} mono />
        <Field label="Puppet Role" value={worker.puppet_role} mono />
        <Field label="Serial Number" value={worker.mdm.serial_number} mono />
        <Field label="KVM" value={worker.kvm} mono />
        {worker.loaner_assignee && <Field label="Loaner Assigned To" value={worker.loaner_assignee} />}
        {worker.notes && worker.notes !== worker.dashboard_notes && <Field label="Sheet Notes" value={worker.notes} />}
        <div className="col-span-2 lg:col-span-3">
          <div className="text-[11px] text-gray-600 mb-1.5 uppercase tracking-wider">Notes</div>
          <InlineNoteEditor hostname={worker.hostname} initial={worker.dashboard_notes} />
        </div>
      </Section>

      <Section title="Taskcluster">
        <Field label="TC Worker ID" value={worker.tc.worker_id} mono />
        <Field label="Worker Group" value={worker.tc.worker_group} mono />
        <Field label="State" value={worker.tc.state} />
        <Field label="Last Active" value={fmtDate(worker.tc.last_active)} />
        <Field label="First Claim" value={fmtDate(worker.tc.first_claim)} />
        <Field label="Quarantined" value={worker.tc.quarantined ? `Yes (until ${fmtDate(worker.tc.quarantine_until)})` : "No"} />
        {worker.tc.latest_task_id && (
          <Field label="Latest Task" value={
            <a
              href={`https://firefox-ci-tc.services.mozilla.com/tasks/${worker.tc.latest_task_id}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-brand-400 hover:text-brand-300 transition-colors"
            >
              {worker.tc.latest_task_id.slice(0, 12)}… <ExternalLink size={9} />
            </a>
          } />
        )}
        {worker.tc.latest_task_state && <Field label="Latest Task State" value={worker.tc.latest_task_state} />}
      </Section>

      <Section title="MDM / Device">
        <Field label="OS Version" value={worker.mdm.os_version} />
        <Field label="Enrollment" value={enrollmentBadge(worker.mdm.enrollment_status)} />
        <Field label="MDM Name" value={worker.mdm.name} />
        <Field label="Resolution" value={worker.mdm.resolution} />
        <Field label="Refresh Rate" value={worker.mdm.refresh_hz ? `${worker.mdm.refresh_hz} Hz` : null} />
        <Field label="Safari Driver" value={worker.mdm.safari_driver} />
        <Field label="Video Dongle" value={worker.mdm.video_dongle} />
        <Field label="Worker Config" value={worker.mdm.worker_config} mono />
        <Field label="Branch Override" value={worker.mdm.branch} mono />
        <Field label="Git Version" value={worker.mdm.git_version} mono />
      </Section>

      <Section title="Sync Timestamps">
        <Field label="Puppet" value={fmtDate(worker.sync.puppet)} />
        <Field label="SimpleMDM" value={fmtDate(worker.sync.mdm)} />
        <Field label="Taskcluster" value={fmtDate(worker.sync.tc)} />
        <Field label="Google Sheets" value={fmtDate(worker.sync.sheet)} />
      </Section>

      {showShell && <ShellModal hostname={worker.hostname} onClose={() => setShowShell(false)} />}
      {showVnc && <VncModal hostname={worker.hostname} onClose={() => setShowVnc(false)} />}
    </div>
  );
}
