import { useEffect, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle, Download, GitCompare, Package } from "lucide-react";
import { api } from "../api";
import type { SbomDiff, SbomHost, SbomResponse, SbomRole } from "../api";
import { FF_GRADIENT } from "../lib/brand";
import { Kit } from "../components/Kit";
import type { KitPose } from "../lib/kit";
import { usePoll, useNow } from "../lib/useLive";

/**
 * macOS fleet SBOM, by puppet role.
 *
 * Every host is built from a role, so the fleet holds a handful of distinct software
 * states rather than one per host: hosts are grouped by the hash ronin_puppet's
 * macos_sbom computes over component identity. A host whose hash differs from its
 * role's most common one has drifted — software its siblings don't have.
 *
 * The page leads with that answer. Each role is a strip with one cell per host, so a
 * converged role reads as one calm bar and a drifted host is the bright sliver in it;
 * the reason it drifted is printed on its row, not behind a click.
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

const shortHost = (h: string) => h.replace(/\.test\.releng\..*$/, "");
const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "—");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type State = SbomHost["state"];

const STATE_LABEL: Record<State, string> = {
  ok: "matches", drifted: "drifted", stale: "stale", unreachable: "unreachable", unknown: "not reporting",
};
const STATE_HINT: Record<State, string> = {
  ok: "matches its role's usual software state",
  drifted: "has software the rest of its role doesn't",
  stale: "no fresh fingerprint in 48h — puppet may not be converging",
  unreachable: "the agent hasn't read this host in 3h",
  unknown: "has never reported a fingerprint",
};
const STATE_TEXT: Record<State, string> = {
  ok: "text-gray-500", drifted: "text-orange-300", stale: "text-yellow-300/90",
  unreachable: "text-gray-500", unknown: "text-gray-500",
};
// Cells sort calm-first, so a strip reads as a bar with any trouble gathered at its end.
const STATE_ORDER: Record<State, number> = { ok: 0, stale: 2, drifted: 3, unreachable: 4, unknown: 5 };

/** Cell colour. In a split role the second state gets its own hue rather than "drifted":
 *  nobody is wrong yet, the role is just mid-change. */
function cellClass(h: SbomHost, role: SbomRole): string {
  if (h.state === "drifted") return "bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.7)] min-w-[4px]";
  if (h.state === "stale") return "bg-yellow-500/55";
  if (h.state === "unreachable" || h.state === "unknown") return "ring-1 ring-inset ring-gray-600/80";
  if (role.split && h.sbom_sha256 !== role.states[0]?.sbom_sha256) return "bg-purple-400/70";
  return "bg-brand-500/40";
}

// Past this many hosts a cell per host gets thinner than a pixel at laptop widths, and
// clipping would hide exactly the cells that matter (trouble sorts last). Bigger roles
// draw one segment per state instead, sized by host count, with every problem host
// guaranteed a visible sliver.
const PER_HOST_MAX = 60;

const byHost = (a: SbomHost, b: SbomHost) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true });

/** One cell per host for small roles; proportional segments for large ones. */
function HostStrip({ role, hosts }: { role: SbomRole; hosts: SbomHost[] }) {
  const rank = (h: SbomHost) =>
    role.split && h.state === "ok" && h.sbom_sha256 !== role.states[0]?.sbom_sha256 ? 1 : STATE_ORDER[h.state];
  const sorted = useMemo(() => [...hosts].sort((a, b) => rank(a) - rank(b) || byHost(a, b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hosts, role]);
  const label = `${hosts.length} hosts: ${role.drifted} drifted, ${role.unhealthy} not current`;

  if (hosts.length <= PER_HOST_MAX) {
    return (
      <div className="flex items-stretch gap-px h-4 w-full min-w-0" role="img" aria-label={label}>
        {sorted.map(h => (
          <span key={h.hostname} title={`${shortHost(h.hostname)} — ${STATE_HINT[h.state]}`}
            className={`flex-1 max-w-[14px] min-w-px rounded-[2px] ${cellClass(h, role)}`} />
        ))}
      </div>
    );
  }

  // Consecutive hosts with the same look become one segment.
  const segments: { cls: string; hosts: SbomHost[]; trouble: boolean }[] = [];
  for (const h of sorted) {
    const cls = cellClass(h, role);
    const last = segments[segments.length - 1];
    if (last && last.cls === cls) last.hosts.push(h);
    else segments.push({ cls, hosts: [h], trouble: h.state !== "ok" });
  }
  return (
    <div className="flex items-stretch gap-[3px] h-4 w-full min-w-0" role="img" aria-label={label}>
      {segments.map((seg, i) => {
        const names = seg.hosts.map(h => shortHost(h.hostname));
        const title = seg.trouble
          ? `${names.join(", ")} — ${STATE_HINT[seg.hosts[0].state]}`
          : `${seg.hosts.length} hosts — ${STATE_HINT[seg.hosts[0].state]}`;
        return (
          <span key={i} title={title}
            className={`rounded-[3px] ${seg.cls}`}
            style={{ flexGrow: seg.hosts.length, flexBasis: 0, minWidth: seg.trouble ? seg.hosts.length * 5 : 6 }} />
        );
      })}
    </div>
  );
}

function RoleVerdict({ role }: { role: SbomRole }) {
  return (
    <div className="text-xs text-right whitespace-nowrap">
      {role.split ? (
        <span className="text-purple-300" title="no single most-common state — likely mid-rollout">
          split {role.states.map(s => s.hosts).join(" / ")}
        </span>
      ) : role.drifted ? (
        <span className="text-orange-300">{plural(role.drifted, "drifted host")}</span>
      ) : role.states.length ? (
        <span className="text-emerald-400/90">converged</span>
      ) : (
        <span className="text-gray-600">no data</span>
      )}
      {role.unhealthy > 0 && <div className="text-[11px] text-gray-600 mt-0.5">{role.unhealthy} not current</div>}
    </div>
  );
}

/** A diff line, coloured by its leading glyph (~ changed, + added, − removed). */
function DiffLine({ text }: { text: string }) {
  const tone = text.startsWith("~") ? "text-yellow-200/80" : text.startsWith("+") ? "text-emerald-300/85" : "text-red-300/85";
  return <div className={`font-mono text-[11px] truncate ${tone}`}>{text}</div>;
}

function FullDiff({ base, head }: { base: string; head: string }) {
  const [diff, setDiff] = useState<SbomDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.sbom.diff(base, head).then(setDiff).catch(e => setErr(String(e))); }, [base, head]);
  if (err) return <div className="text-xs text-gray-500">Couldn't load the diff: {err}</div>;
  if (!diff) return <LoaderCircle size={12} className="animate-spin text-gray-600" />;
  const lines = [
    ...diff.changed.map(c => `~ ${c.name} ${c.base} → ${c.head}`),
    ...diff.added.map(c => `+ ${c.name} ${c.version}`),
    ...diff.removed.map(c => `− ${c.name} ${c.version}`),
  ];
  return (
    <div className="max-h-64 overflow-y-auto space-y-0.5 pr-2">
      {lines.length ? lines.map(l => <DiffLine key={l} text={l} />)
        : <div className="text-[11px] text-gray-500">Same components by name; only unversioned file hashes differ.</div>}
    </div>
  );
}

function AttentionHost({ h, modal, now }: { h: SbomHost; modal: string | null; now: number }) {
  const [full, setFull] = useState(false);
  const d = h.drift;
  const more = d ? d.added + d.removed + d.changed - d.highlights.length : 0;
  return (
    <div className="grid grid-cols-[150px_110px_1fr] gap-x-4 py-2 items-start">
      <div className="font-mono text-xs text-gray-200 pt-px">{shortHost(h.hostname)}</div>
      <div className={`text-xs ${STATE_TEXT[h.state]}`} title={STATE_HINT[h.state]}>{STATE_LABEL[h.state]}</div>
      <div className="min-w-0">
        {h.state === "drifted" && modal && h.sbom_sha256 ? (
          full ? <FullDiff base={modal} head={h.sbom_sha256} /> : (
            <>
              {d ? d.highlights.map(l => <DiffLine key={l} text={l} />)
                : <div className="text-[11px] text-gray-600">differs from the role — documents still being collected</div>}
              <button onClick={() => setFull(true)}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-300">
                <GitCompare size={11} /> {more > 0 ? `${more} more` : "full diff"}
              </button>
            </>
          )
        ) : h.agent_error ? (
          <div className="text-[11px] text-gray-500 truncate" title={h.agent_error}>{h.agent_error}</div>
        ) : (
          <div className="text-[11px] text-gray-500">last generated {ago(h.generated_at, now)}</div>
        )}
      </div>
    </div>
  );
}

function RoleCard({ role, hosts, now }: { role: SbomRole; hosts: SbomHost[]; now: number }) {
  const [open, setOpen] = useState(role.drifted > 0);
  const [showOk, setShowOk] = useState(false);
  const attention = hosts.filter(h => h.state !== "ok").sort(byHost);
  const matching = hosts.filter(h => h.state === "ok").sort(byHost);
  const os = useMemo(() => [...new Set(hosts.map(h => h.macos_version).filter(Boolean))].join(", "), [hosts]);

  return (
    <div className={`border-b border-gray-800/60 last:border-b-0 ${role.drifted ? "bg-orange-500/[0.025]" : ""}`}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full grid grid-cols-[minmax(200px,280px)_minmax(0,1fr)_120px] gap-6 items-center px-5 py-3.5 text-left hover:bg-white/[0.015] transition-colors">
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight size={13} className={`text-gray-600 flex-shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          <div className="min-w-0">
            <div className="font-mono text-[13px] text-gray-100 truncate">{role.puppet_role}</div>
            <div className="text-[11px] text-gray-600 mt-0.5">
              {plural(role.hosts, "host")}{os && <> · macOS {os}</>}
            </div>
          </div>
        </div>
        <HostStrip role={role} hosts={hosts} />
        <RoleVerdict role={role} />
      </button>

      {open && (
        <div className="pl-[46px] pr-5 pb-4 space-y-4">
          {attention.length > 0 && (
            <div className="divide-y divide-gray-800/40">
              {attention.map(h => <AttentionHost key={h.hostname} h={h} modal={role.modal_sha256} now={now} />)}
            </div>
          )}

          {matching.length > 0 && (
            <div>
              <button onClick={() => setShowOk(v => !v)} className="text-[11px] text-gray-600 hover:text-gray-300">
                {attention.length === 0
                  ? `All ${plural(matching.length, "host")} match`
                  : `${plural(matching.length, "other host")} match`}
                {" · "}{showOk ? "hide" : "show"}
              </button>
              {showOk && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {matching.map(h => (
                    <span key={h.hostname} className="font-mono text-[10px] text-gray-500 bg-gray-800/40 rounded px-1.5 py-0.5">
                      {shortHost(h.hostname)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-gray-600 mr-1">States</span>
            {role.states.map(s => {
              const baseline = s.sbom_sha256 === role.modal_sha256;
              return (
                <span key={s.sbom_sha256}
                  title={`${s.sbom_sha256}${s.component_count !== null ? ` · ${s.component_count} components` : ""}`}
                  className={`inline-flex items-center gap-1.5 text-[11px] rounded-md pl-2 pr-1.5 py-0.5 border ${
                    baseline ? "border-brand-500/30 bg-brand-500/[0.06] text-brand-200" : "border-gray-700/70 text-gray-400"}`}>
                  {baseline && <span className="text-[10px] uppercase tracking-wider text-brand-300/80">baseline</span>}
                  <span className="font-mono">{short(s.sbom_sha256)}</span>
                  <span className="text-gray-600">{s.hosts}</span>
                  {s.document ? (
                    <a href={api.sbom.documentUrl(s.sbom_sha256)} className="text-gray-500 hover:text-white p-0.5"
                      title="download CycloneDX 1.6 JSON">
                      <Download size={11} />
                    </a>
                  ) : (
                    <span className="text-gray-700" title="document arrives on the agent's next sweep">…</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The answer, in one sentence, with Kit's pose matching it. */
function verdict(data: SbomResponse): { pose: KitPose; headline: React.ReactNode; detail: string } {
  const t = data.totals;
  const roles = plural(t.roles, "role");
  if (data.agent_stale) {
    return {
      pose: "alert",
      headline: "The SBOM agent has gone quiet",
      detail: `Last sweep ${data.last_collected_at ? "was over 3 hours ago" : "never happened"} — what's below may be out of date.`,
    };
  }
  if (t.drifted > 0) {
    const others = t.reporting - t.drifted;
    return {
      pose: "inquisitive",
      headline: <><span className="text-orange-300">{plural(t.drifted, "host")}</span> {t.drifted === 1 ? "doesn't" : "don't"} match {t.drifted === 1 ? "its role" : "their role"}</>,
      detail: `${t.roles_drifted} of ${roles} affected. The other ${others} hosts match theirs.`,
    };
  }
  return {
    pose: "checkmark",
    headline: "Every host matches its role",
    detail: `${t.reporting} hosts in ${plural(t.distinct_states, "software state")} across ${roles}.`,
  };
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
  const v = data && t && t.hosts > 0 ? verdict(data) : null;

  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <span className="w-1 h-9 rounded-full flex-shrink-0" style={{ backgroundImage: FF_GRADIENT }} />
        <div>
          <h1 className="text-2xl font-light text-white tracking-tight">macOS SBOM</h1>
          <p className="text-gray-500 text-sm mt-0.5">What's installed on every Mac, and which ones don't match their role</p>
        </div>
      </div>

      {err && !data && <div className="card p-5 text-sm text-gray-500">Couldn't load the SBOM: {err}</div>}

      {!err && !data && (
        <div className="card p-5 text-sm text-gray-600 flex items-center gap-2">
          <LoaderCircle size={14} className="animate-spin" /> Loading SBOM…
        </div>
      )}

      {data && t && t.hosts === 0 && (
        <div className="card p-8 flex items-center gap-6">
          <Kit pose="lookingForward" size={88} />
          <div className="text-sm text-gray-400 max-w-xl">
            <div className="text-lg text-white font-light mb-1">No fingerprints yet</div>
            Hosts write them once ronin_puppet's <span className="font-mono text-xs">macos_sbom</span> profile
            applies, and the on-network agent (<span className="font-mono text-xs">orchestrator/sbom_agent.py</span>)
            brings them here from inside MDC1.
          </div>
        </div>
      )}

      {data && t && v && (
        <>
          <div className="card relative overflow-hidden px-7 py-6 flex items-center gap-6">
            <div className="absolute inset-x-0 top-0 h-px opacity-60" style={{ backgroundImage: FF_GRADIENT }} />
            <Kit pose={v.pose} size={84} className="flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[26px] leading-tight font-light text-white tracking-tight">{v.headline}</div>
              <div className="text-sm text-gray-500 mt-1.5">{v.detail}</div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 mt-4 text-[11px] text-gray-600">
                <span><span className="text-gray-300 tabular-nums">{t.reporting}</span>/{t.hosts} reporting</span>
                <span><span className="text-gray-300 tabular-nums">{t.distinct_states}</span> software states</span>
                <span><span className="text-gray-300 tabular-nums">{t.roles}</span> roles</span>
                <span>collected <span className="text-gray-300">{ago(data.last_collected_at, now)}</span></span>
              </div>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="grid grid-cols-[minmax(200px,280px)_minmax(0,1fr)_120px] gap-6 px-5 py-2.5 border-b border-gray-800/60 text-[10px] uppercase tracking-wider text-gray-600">
              <span className="pl-[21px]">Role</span>
              <span className="flex items-center gap-3">
                Hosts
                <span className="normal-case tracking-normal flex items-center gap-3 text-gray-600">
                  <Legend cls="bg-brand-500/40" label="matches" />
                  <Legend cls="bg-orange-400" label="drifted" />
                  <Legend cls="bg-yellow-500/55" label="stale" />
                  <Legend cls="ring-1 ring-inset ring-gray-600/80" label="not reporting" />
                </span>
              </span>
              <span className="text-right">State</span>
            </div>
            {data.roles.map(r => (
              <RoleCard key={r.puppet_role} role={r} hosts={hostsByRole.get(r.puppet_role) ?? []} now={now} />
            ))}
          </div>

          <p className="text-[11px] text-gray-600 flex items-start gap-1.5 max-w-3xl">
            <Package size={12} className="mt-0.5 flex-shrink-0" />
            Covers the provisioned image: installer receipts, Xcode/CLT, pip packages,
            /usr/local/bin binaries and Homebrew. Toolchains a task fetches at run time are
            ephemeral and not included. Each state downloads as CycloneDX 1.6 for a scanner.
          </p>
        </>
      )}
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block w-2 h-3 rounded-[2px] ${cls}`} /> {label}
    </span>
  );
}

export default Sbom;
