import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, ShieldCheck, Download, Layers,
  GitCompare, Clock, Package } from "lucide-react";
import { api } from "../api";
import type { SbomDiff, SbomHost, SbomResponse, SbomRole } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { Badge } from "../components/Badge";
import { usePoll, useNow } from "../lib/useLive";

/**
 * macOS fleet SBOM, by puppet role.
 *
 * Every host is built from a role, so the fleet holds a handful of distinct software
 * states rather than one per host: hosts are grouped by the hash ronin_puppet's
 * macos_sbom computes over component identity. A host whose hash differs from its
 * role's most common one has drifted — software its siblings don't have.
 *
 * Data arrives from the on-network agent (`orchestrator/sbom_agent.py`); Cloud Run
 * cannot reach MDC1, so nothing here is collected by Hangar itself.
 */

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function shortHost(h: string): string {
  return h.replace(/\.test\.releng\..*$/, "");
}

const short = (sha: string | null) => (sha ? sha.slice(0, 10) : "—");

const STATE_VARIANT = {
  ok: "green", drifted: "orange", stale: "yellow", unreachable: "gray", unknown: "gray",
} as const;

const STATE_HINT: Record<SbomHost["state"], string> = {
  ok: "matches its role's usual software state",
  drifted: "software differs from the rest of its role",
  stale: "no fresh fingerprint in 48h — puppet may not be converging",
  unreachable: "the agent hasn't read this host in 3h",
  unknown: "never reported a fingerprint",
};

function Tile({ icon, label, value, hint }: {
  icon: React.ReactNode; label: string; value: string; hint?: string;
}) {
  return (
    <div className="card px-4 py-3" title={hint}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-gray-600">
        {icon} {label}
      </div>
      <div className="text-xl font-light text-white mt-1 tabular-nums">{value}</div>
    </div>
  );
}

/** A software state: short hash, how many hosts share it, and a download if Hangar holds it. */
function StateChip({ s, modal }: { s: SbomRole["states"][number]; modal: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-mono rounded-md px-1.5 py-0.5 border ${
      modal ? "border-brand-500/30 text-brand-300" : "border-gray-700/70 text-gray-400"}`}
      title={`${s.sbom_sha256}${s.component_count !== null ? ` · ${s.component_count} components` : ""}`}>
      {short(s.sbom_sha256)}
      <span className="text-gray-600">×{s.hosts}</span>
      {s.document ? (
        <a href={api.sbom.documentUrl(s.sbom_sha256)} onClick={e => e.stopPropagation()}
          className="text-gray-500 hover:text-white" title="download CycloneDX 1.6 JSON">
          <Download size={11} />
        </a>
      ) : (
        <span className="text-gray-700" title="document not collected yet — the agent fetches it next sweep">…</span>
      )}
    </span>
  );
}

function DiffView({ base, head }: { base: string; head: string }) {
  const [diff, setDiff] = useState<SbomDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.sbom.diff(base, head).then(setDiff).catch(e => setErr(String(e)));
  }, [base, head]);

  if (err) return <div className="text-xs text-gray-500">Couldn't load the diff: {err}</div>;
  if (!diff) return <div className="text-xs text-gray-600 flex items-center gap-1.5"><LoaderCircle size={12} className="animate-spin" /> diffing…</div>;
  const none = !diff.added.length && !diff.removed.length && !diff.changed.length;
  return (
    <div className="text-[11px] font-mono space-y-0.5 max-h-72 overflow-y-auto">
      {none && <div className="text-gray-500">No component differences by name — only hashes of unversioned files differ.</div>}
      {diff.changed.map(c => (
        <div key={`c-${c.type}-${c.name}`} className="text-yellow-300/90">
          ~ {c.name} <span className="text-gray-500">{c.base} → {c.head}</span>
        </div>
      ))}
      {diff.added.map(c => (
        <div key={`a-${c.type}-${c.name}`} className="text-emerald-300/90">
          + {c.name} <span className="text-gray-500">{c.version}</span>
        </div>
      ))}
      {diff.removed.map(c => (
        <div key={`r-${c.type}-${c.name}`} className="text-red-300/90">
          − {c.name} <span className="text-gray-500">{c.version}</span>
        </div>
      ))}
    </div>
  );
}

function HostRow({ h, modal, now }: { h: SbomHost; modal: string | null; now: number }) {
  const [open, setOpen] = useState(false);
  const canDiff = h.state === "drifted" && !!modal && !!h.sbom_sha256;
  return (
    <>
      <tr className={canDiff ? "cursor-pointer hover:bg-gray-900/40" : ""}
        onClick={canDiff ? () => setOpen(o => !o) : undefined}>
        <td className="py-1.5 pl-8 pr-1 w-4 text-gray-600">
          {canDiff && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </td>
        <td className="py-1.5 pr-4 font-mono text-xs text-gray-300 whitespace-nowrap">{shortHost(h.hostname)}</td>
        <td className="py-1.5 pr-4" title={STATE_HINT[h.state]}>
          <Badge label={h.state} variant={STATE_VARIANT[h.state]} dot />
        </td>
        <td className="py-1.5 pr-4 font-mono text-xs text-gray-500">{short(h.sbom_sha256)}</td>
        <td className="py-1.5 pr-4 text-xs text-gray-500 whitespace-nowrap">
          {h.macos_version ?? "—"}{h.is_vm && <span className="text-gray-600"> · vm</span>}
        </td>
        <td className="py-1.5 pr-4 text-xs text-gray-600 whitespace-nowrap">{h.component_count ?? "—"}</td>
        <td className="py-1.5 pr-2 text-xs text-gray-600 max-w-[280px] truncate">
          {h.agent_error
            ? <span className="text-gray-400" title={h.agent_error}>{h.agent_error}</span>
            : <>generated {ago(h.generated_at, now)}</>}
        </td>
      </tr>
      {open && canDiff && (
        <tr>
          <td />
          <td colSpan={6} className="pb-3 pr-2">
            <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1 flex items-center gap-1">
              <GitCompare size={11} /> vs role's usual state {short(modal)}
            </div>
            <DiffView base={modal!} head={h.sbom_sha256!} />
          </td>
        </tr>
      )}
    </>
  );
}

function RoleRows({ role, hosts, now }: { role: SbomRole; hosts: SbomHost[]; now: number }) {
  const [open, setOpen] = useState(role.drifted > 0);
  return (
    <>
      <tr className={`cursor-pointer hover:bg-gray-900/40 ${role.drifted ? "border-l-2 border-l-orange-700/60" : "border-l-2 border-l-transparent"}`}
        onClick={() => setOpen(o => !o)}>
        <td className="py-2 pl-2 pr-1 w-4 text-gray-600">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
        <td className="py-2 pr-4 font-mono text-xs text-gray-200 whitespace-nowrap">{role.puppet_role}</td>
        <td className="py-2 pr-4 text-xs text-gray-500 tabular-nums">{role.hosts}</td>
        <td className="py-2 pr-4">
          <div className="flex flex-wrap gap-1">
            {role.states.map(s => <StateChip key={s.sbom_sha256} s={s} modal={s.sbom_sha256 === role.modal_sha256} />)}
          </div>
        </td>
        <td className="py-2 pr-2 text-xs whitespace-nowrap">
          {role.split ? <span className="text-yellow-400" title="no single most-common state — likely mid-rollout">split</span>
            : role.drifted ? <span className="text-orange-400">{role.drifted} drifted</span>
            : role.states.length === 1 ? <span className="text-emerald-400">converged</span>
            : <span className="text-gray-600">—</span>}
          {role.unhealthy > 0 && <span className="text-gray-500 ml-1.5">{role.unhealthy} not reporting</span>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="p-0">
            <table className="w-full text-left">
              <tbody className="divide-y divide-gray-800/30">
                {hosts.map(h => <HostRow key={h.hostname} h={h} modal={role.modal_sha256} now={now} />)}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

export function Sbom() {
  const [data, setData] = useState<SbomResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(60_000);

  const load = () => api.sbom.get().then(d => { setData(d); setErr(null); }).catch(e => setErr(String(e)));
  useEffect(() => { load(); }, []);
  usePoll(load, 300_000);

  const hostsByRole = useMemo(() => {
    const m = new Map<string, SbomHost[]>();
    for (const h of data?.hosts ?? []) {
      const k = h.puppet_role ?? "(unknown role)";
      m.set(k, [...(m.get(k) ?? []), h]);
    }
    return m;
  }, [data]);

  const t = data?.totals;
  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="w-1 h-9 rounded-full flex-shrink-0" style={{ backgroundImage: FF_GRADIENT }} />
          <div>
            <h1 className="text-2xl font-light text-white tracking-tight">macOS SBOM</h1>
            <p className="text-gray-500 text-sm mt-0.5">
              {t ? <>{t.reporting} hosts in {t.distinct_states} distinct software states</> : "Loading…"}
              {data && <span className="text-gray-600"> · collected {ago(data.last_collected_at, now)}</span>}
            </p>
          </div>
        </div>
        {data && (
          <div className="flex items-center gap-1.5">
            {data.agent_stale && <Badge label="agent stale" variant="yellow" dot />}
            {t && t.drifted > 0
              ? <Badge label={`${t.drifted} drifted`} variant="orange" dot />
              : t && t.hosts > 0 && <Badge label="no drift" variant="green" dot />}
          </div>
        )}
      </div>

      {err && !data && <div className="card p-5 text-sm text-gray-500">Couldn't load the SBOM: {err}</div>}

      {!err && !data && (
        <div className="card p-5 text-sm text-gray-600 flex items-center gap-2">
          <LoaderCircle size={14} className="animate-spin" /> Loading SBOM…
        </div>
      )}

      {data && t && t.hosts === 0 && (
        <div className="card p-5 text-sm text-gray-500">
          No SBOM fingerprints have been collected yet. Hosts write them once ronin_puppet's
          <span className="font-mono text-xs"> macos_sbom</span> profile applies; the on-network agent
          (<span className="font-mono text-xs">orchestrator/sbom_agent.py</span>) pushes them from inside MDC1.
        </div>
      )}

      {data && t && t.hosts > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile icon={<ShieldCheck size={11} />} label="Reporting" value={`${t.reporting}/${t.hosts}`} />
            <Tile icon={<Layers size={11} />} label="Software states" value={`${t.distinct_states}`}
              hint="distinct component sets across the fleet; ideally about one per role" />
            <Tile icon={<Package size={11} />} label="Documents held" value={`${t.documents}`}
              hint="CycloneDX documents stored, one per software state" />
            <Tile icon={<Clock size={11} />} label="Last collected" value={ago(data.last_collected_at, now)} />
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-gray-600 border-b border-gray-800/60">
                    <th />
                    <th className="py-2 pr-4 font-medium">Role</th>
                    <th className="py-2 pr-4 font-medium">Hosts</th>
                    <th className="py-2 pr-4 font-medium">Software states</th>
                    <th className="py-2 pr-2 font-medium">Drift</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {data.roles.map(r => (
                    <RoleRows key={r.puppet_role} role={r} hosts={hostsByRole.get(r.puppet_role) ?? []} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-[11px] text-gray-600 flex items-start gap-1.5 max-w-3xl">
            <Package size={12} className="mt-0.5 flex-shrink-0" />
            Covers the provisioned image: installer receipts, Xcode/CLT, pip packages,
            /usr/local/bin binaries and Homebrew. Toolchains a task fetches at run time are
            ephemeral and not included.
          </p>
        </>
      )}
    </div>
  );
}

export default Sbom;
