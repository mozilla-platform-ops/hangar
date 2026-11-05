import { useEffect, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle, Download, GitCompare, Package, SlidersHorizontal } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { SbomConfigSheet } from "../components/SbomConfigSheet";
import { api } from "../api";
import type { SbomDiff, SbomFinding, SbomHost, SbomResponse, SbomRole } from "../api";
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
  updating: "updating",
  pending: "differs",
};
const STATE_HINT: Record<State, string> = {
  ok: "matches its role's usual software state",
  drifted: "has software the rest of its role doesn't",
  stale: "no fresh fingerprint in 48h — puppet may not be converging",
  unreachable: "the agent hasn't read this host in 3h",
  unknown: "has never reported a fingerprint",
  updating: "still on an older SBOM generator than the rest of its role, so not compared yet",
  pending: "differs from its role; details arrive with its document on the agent's next sweep",
};
const STATE_TEXT: Record<State, string> = {
  ok: "text-gray-500", drifted: "text-orange-300", stale: "text-yellow-300/90",
  unreachable: "text-gray-500", unknown: "text-gray-500", updating: "text-gray-500",
  pending: "text-orange-300/70",
};
// Cells sort calm-first, so a strip reads as a bar with any trouble gathered at its end.
const STATE_ORDER: Record<State, number> = { ok: 0, updating: 1.5, stale: 2, drifted: 3, pending: 3.5, unreachable: 4, unknown: 5 };

/** Cell colour. In a split role the second state gets its own hue rather than "drifted":
 *  nobody is wrong yet, the role is just mid-change. */
function cellClass(h: SbomHost, role: SbomRole): string {
  if (h.state === "drifted") return "bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.7)] min-w-[4px]";
  if (h.state === "stale") return "bg-yellow-500/55";
  if (h.state === "updating") return "bg-brand-500/15";
  if (h.state === "pending") return "bg-orange-400/35";
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
    else segments.push({ cls, hosts: [h], trouble: h.state !== "ok" && h.state !== "updating" });
  }
  return (
    <div className="flex items-stretch gap-[3px] h-4 w-full min-w-0 overflow-hidden" role="img" aria-label={label}>
      {segments.map((seg, i) => {
        const names = seg.hosts.map(h => shortHost(h.hostname));
        const title = seg.trouble
          ? `${names.join(", ")} — ${STATE_HINT[seg.hosts[0].state]}`
          : `${seg.hosts.length} hosts — ${STATE_HINT[seg.hosts[0].state]}`;
        return (
          <span key={i} title={title}
            className={`rounded-[3px] ${seg.cls}`}
            style={{ flexGrow: seg.hosts.length, flexBasis: 0, minWidth: seg.trouble ? Math.min(seg.hosts.length * 5, 40) : 6 }} />
        );
      })}
    </div>
  );
}

/** One line: the role's answer. Differences lead; anything not current trails, muted. */
function RoleVerdict({ role }: { role: SbomRole }) {
  const n = role.findings.length;
  const main = n ? <span className="text-orange-300">{plural(n, "difference")}</span>
    : role.pending ? <span className="text-orange-300/70">details pending</span>
    : role.states.length ? <span className="text-emerald-400/90">converged</span>
    : <span className="text-gray-600">no data</span>;
  const extra = [
    role.unhealthy > 0 ? `${role.unhealthy} not current` : null,
    role.updating > 0 ? `${role.updating} updating` : null,
  ].filter(Boolean);
  return (
    <div className="text-xs text-right whitespace-nowrap truncate">
      {main}
      {extra.length > 0 && <span className="text-gray-600"> · {extra.join(" · ")}</span>}
    </div>
  );
}

const FINDING_PREVIEW = 3;
const FINDINGS_SHOWN = 6;

/** One difference from the cohort's majority. What changed leads; who carries it follows. */
function FindingRow({ finding, total }: { finding: SbomFinding; total: number }) {
  const [all, setAll] = useState(false);
  const [allHosts, setAllHosts] = useState(false);
  const names = finding.hosts.map(shortHost);
  const items = all ? finding.items : finding.items.slice(0, FINDING_PREVIEW);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(180px,300px)] gap-x-6 py-2 items-start">
      <div className="min-w-0">
        {items.map(i => <DiffLine key={`${i.kind}${i.name}`} text={i.label} />)}
        {finding.items.length > FINDING_PREVIEW && (
          <button onClick={() => setAll(v => !v)} className="mt-0.5 text-[11px] text-gray-600 hover:text-gray-300">
            {all ? "show fewer" : `+${finding.items.length - FINDING_PREVIEW} more`}
          </button>
        )}
      </div>
      <button onClick={() => setAllHosts(v => !v)} title={names.join(", ")}
        className={`min-w-0 text-left text-[11px] leading-5 group ${allHosts ? "break-words" : "truncate"}`}>
        <span className="text-gray-300 tabular-nums">{names.length}</span>
        <span className="text-gray-600"> of {total} · </span>
        <span className="font-mono text-gray-500 group-hover:text-gray-400">
          {compressHosts(names).replace(/^macmini-/, "")}
        </span>
      </button>
    </div>
  );
}

/** A diff line, coloured by its leading glyph (~ changed, + added, − removed). */
function DiffLine({ text }: { text: string }) {
  const tone = text.startsWith("~") ? "text-yellow-200/80" : text.startsWith("+") ? "text-emerald-300/85"
    : text.startsWith("≠") ? "text-purple-300/85" : "text-red-300/85";
  return <div className={`font-mono text-[11px] leading-5 truncate ${tone}`} title={text}>{text}</div>;
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
    <div className="max-h-64 overflow-y-auto pr-2">
      {lines.length ? lines.map(l => <DiffLine key={l} text={l} />)
        : <div className="text-[11px] text-gray-500">Same components by name; only unversioned file hashes differ.</div>}
    </div>
  );
}

/** `macmini-r8-165, -166, -167, -171` -> `macmini-r8-165–167, 171`. Falls back to the
 *  plain list when the names don't share a numbered prefix. */
function compressHosts(names: string[]): string {
  const parsed = names.map(n => n.match(/^(.*?)(\d+)$/));
  const prefix = parsed[0]?.[1];
  if (!prefix || parsed.some(m => !m || m[1] !== prefix)) return names.join(", ");
  const nums = [...new Set(parsed.map(m => Number(m![2])))].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    runs.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return prefix + runs.join(", ");
}

/** A drifted host whose own diff is known but isn't one of the role's shared findings. */
function DriftDetail({ hosts, modal }: { hosts: SbomHost[]; modal: string }) {
  const h = hosts[0];
  const [full, setFull] = useState(false);
  const d = h.drift;
  const more = d ? d.added + d.removed + d.changed - d.highlights.length : 0;
  if (!h.sbom_sha256 || new Set(hosts.map(x => x.sbom_sha256)).size > 1 || !d)
    return <span className="text-gray-600">documents still being collected</span>;
  if (full) return <FullDiff base={modal} head={h.sbom_sha256} />;
  return (
    <>
      {d.highlights.map(l => <DiffLine key={l} text={l} />)}
      <button onClick={() => setFull(true)} className="inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-300">
        <GitCompare size={11} /> {more > 0 ? `${more} more` : "full diff"}
      </button>
    </>
  );
}

/** Why a group of hosts isn't being compared, in one line. */
function attentionReason(hosts: SbomHost[], now: number): string {
  const h = hosts[0];
  if (h.state === "pending") return "details arrive with the document on the agent's next sweep";
  if (h.agent_error) return hosts.length > 1 ? reasonOf(h).split(" <host>").join("") : h.agent_error;
  const oldest = hosts.map(x => x.generated_at).filter(Boolean).sort()[0] ?? null;
  return `last generated ${ago(oldest, now)}${hosts.length > 1 ? " (oldest)" : ""}`;
}

/** An agent error with the host's own name taken out, so the same failure on two hosts
 *  reads as the same reason ("ssh: connect to host <host> port 22: Operation timed out"). */
function reasonOf(h: SbomHost): string {
  const e = h.agent_error ?? "";
  return e.split(h.hostname).join("<host>").split(shortHost(h.hostname)).join("<host>");
}

/** Hosts that share a state and a reason collapse into one row. Largest group first. */
function groupAttention(hosts: SbomHost[]): SbomHost[][] {
  const groups = new Map<string, SbomHost[]>();
  for (const h of hosts) {
    // Drifted hosts whose documents haven't arrived can't say why yet; until they can,
    // they're one finding ("these differ, details pending"), not one row each.
    // Same for every other state: hosts with the same state and the same reason are
    // one row (39 hosts saying "no fingerprint" is one fact, not 39).
    const key = h.state === "drifted" && !h.drift ? "pending"
      : h.state === "drifted" && h.sbom_sha256 ? `d:${h.sbom_sha256}`
      : `s:${h.state}:${reasonOf(h)}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const order: Record<State, number> = { drifted: 0, pending: 0.5, stale: 1, unreachable: 2, unknown: 3, updating: 4, ok: 5 };
  return [...groups.values()].sort((a, b) =>
    order[a[0].state] - order[b[0].state] || b.length - a.length || byHost(a[0], b[0]));
}

const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_minmax(160px,260px)_minmax(150px,220px)_28px] gap-5 items-center";

function RoleCard({ role, hosts, now, onInspect }: {
  role: SbomRole; hosts: SbomHost[]; now: number; onInspect: () => void;
}) {
  // Folded by default: the row itself is the answer. Open it to see why.
  const [open, setOpen] = useState(false);
  const [allFindings, setAllFindings] = useState(false);
  const [showOk, setShowOk] = useState(false);
  const [showStates, setShowStates] = useState(false);
  // Drifted hosts are shown through the findings they carry, not one by one.
  const attention = hosts.filter(h => !["ok", "updating", "drifted"].includes(h.state)).sort(byHost);
  const matching = hosts.filter(h => h.state === "ok").sort(byHost);
  const updating = hosts.filter(h => h.state === "updating");
  const os = useMemo(() => [...new Set(hosts.map(h => h.macos_version).filter(Boolean))].join(", "), [hosts]);
  const baseline = role.states.find(s => s.sbom_sha256 === role.modal_sha256);
  const others = role.states.filter(s => s.sbom_sha256 !== role.modal_sha256);
  const hasDocs = role.states.some(s => s.document);

  return (
    <div className="group/role border-t border-gray-800/50 first:border-t-0">
      <div role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(o => !o); } }}
        className={`${ROW_GRID} cursor-pointer px-5 py-2 hover:bg-white/[0.02] transition-colors`}>
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight size={13} className={`text-gray-600 flex-shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          <span className="font-mono text-xs text-gray-100 truncate" title={role.puppet_role}>{role.puppet_role}</span>
          {role.puppet_branch && (
            <span className="text-[10px] font-mono text-purple-300/90 border border-purple-400/25 rounded px-1 truncate min-w-0 max-w-[14rem]"
              title={`pinned to puppet branch ${role.puppet_branch}; compared only with hosts on the same branch`}>
              {role.puppet_branch}
            </span>
          )}
          <span className="text-[11px] text-gray-600 whitespace-nowrap flex-shrink-0">
            {role.hosts}{os && <> · {os}</>}
          </span>
        </div>
        <HostStrip role={role} hosts={hosts} />
        <RoleVerdict role={role} />
        <button onClick={e => { e.stopPropagation(); onInspect(); }} disabled={!hasDocs}
          title="Configuration — what's installed" aria-label={`${role.puppet_role} configuration`}
          className="w-6 h-6 rounded-md flex items-center justify-center text-gray-600 hover:text-white hover:bg-white/[0.06] transition opacity-0 group-hover/role:opacity-100 focus-visible:opacity-100 disabled:invisible">
          <SlidersHorizontal size={13} />
        </button>
      </div>

      {open && (
        <div className="pl-[41px] pr-5 pb-4 pt-1">
          {role.findings.length > 0 && (
            <div className="divide-y divide-gray-800/40">
              {(allFindings ? role.findings : role.findings.slice(0, FINDINGS_SHOWN)).map(f => (
                <FindingRow key={f.id} finding={f} total={role.hosts} />
              ))}
              {role.findings.length > FINDINGS_SHOWN && (
                <button onClick={() => setAllFindings(v => !v)} className="pt-2 text-[11px] text-gray-500 hover:text-gray-300">
                  {allFindings ? "show fewer" : `${role.findings.length - FINDINGS_SHOWN} more differences`}
                </button>
              )}
            </div>
          )}

          {attention.length > 0 && (
            <div className={`${role.findings.length ? "mt-3 pt-3 border-t border-gray-800/40" : ""} space-y-1`}>
              {groupAttention(attention).map(g => (
                <div key={g[0].hostname} className="grid grid-cols-[minmax(0,1fr)_minmax(180px,300px)] gap-x-6 text-[11px] items-start">
                  <div className="min-w-0 flex gap-2">
                    <span className={`flex-shrink-0 ${STATE_TEXT[g[0].state]}`} title={STATE_HINT[g[0].state]}>{STATE_LABEL[g[0].state]}</span>
                    <div className="min-w-0 text-gray-600">
                      {g[0].state === "drifted" && role.modal_sha256
                        ? <DriftDetail hosts={g} modal={role.modal_sha256} />
                        : <span className="block truncate" title={g[0].agent_error ?? undefined}>{attentionReason(g, now)}</span>}
                    </div>
                  </div>
                  <div className="min-w-0 truncate" title={g.map(x => shortHost(x.hostname)).join(", ")}>
                    <span className="text-gray-300 tabular-nums">{g.length}</span>
                    <span className="text-gray-600"> · </span>
                    <span className="font-mono text-gray-500">{compressHosts(g.map(x => shortHost(x.hostname))).replace(/^macmini-/, "")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Everything else about the role, on one quiet line. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600">
            {matching.length > 0 && (
              <button onClick={() => setShowOk(v => !v)} className="hover:text-gray-300">
                {attention.length === 0 && role.findings.length === 0
                  ? `All ${plural(matching.length, "host")} match`
                  : `${plural(matching.length, "host")} match the baseline`}
              </button>
            )}
            {updating.length > 0 && (
              <span title={updating.map(h => shortHost(h.hostname)).join(", ")}>
                {updating.length} updating to generator {role.generator_version}
              </span>
            )}
            {baseline && (
              baseline.document ? (
                <a href={api.sbom.documentUrl(baseline.sbom_sha256)} title={`${baseline.sbom_sha256} · CycloneDX 1.6 JSON`}
                  className="inline-flex items-center gap-1 hover:text-gray-300">
                  <Download size={11} /> baseline <span className="font-mono">{short(baseline.sbom_sha256)}</span>
                </a>
              ) : <span>baseline <span className="font-mono">{short(baseline.sbom_sha256)}</span> · document pending</span>
            )}
            {others.length > 0 && (
              <button onClick={() => setShowStates(v => !v)} className="hover:text-gray-300">
                {showStates ? "hide other states" : `${plural(others.length, "other state")}`}
              </button>
            )}
            {hasDocs && (
              <button onClick={onInspect} className="inline-flex items-center gap-1 hover:text-gray-300">
                <SlidersHorizontal size={11} /> configuration
              </button>
            )}
          </div>

          {showOk && (
            <div className="mt-2 font-mono text-[11px] text-gray-500 break-words">
              {compressHosts(matching.map(h => shortHost(h.hostname)))}
            </div>
          )}

          {showStates && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {others.map(s => (
                <span key={s.sbom_sha256}
                  title={`${s.sbom_sha256}${s.component_count !== null ? ` · ${s.component_count} components` : ""}`}
                  className="inline-flex items-center gap-1.5 text-[11px] rounded border border-gray-800 pl-1.5 pr-1 py-px text-gray-400">
                  <span className="font-mono">{short(s.sbom_sha256)}</span>
                  <span className="text-gray-600 tabular-nums">{s.hosts}</span>
                  {s.document ? (
                    <a href={api.sbom.documentUrl(s.sbom_sha256)} className="text-gray-500 hover:text-white" title="download CycloneDX 1.6 JSON">
                      <Download size={10} />
                    </a>
                  ) : <span className="text-gray-700" title="document arrives on the agent's next sweep">…</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Role families, in display order. Names follow ronin_puppet's role conventions.
const FAMILIES: { label: string; test: (role: string) => boolean }[] = [
  { label: "Testers", test: r => /_t_osx_/.test(r) },
  { label: "Tart VM hosts", test: r => r === "tart_worker" || /_vms_host$/.test(r) },
  { label: "Builders", test: r => /_b_osx/.test(r) || /^(mozillavpn|applicationservices|nss|enterprise)_/.test(r) },
];
function family(role: string): string {
  return FAMILIES.find(f => f.test(role))?.label ?? "Other";
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
  if (t.findings > 0) {
    const matching = t.reporting - t.drifted - t.pending - t.updating;
    return {
      pose: "inquisitive",
      headline: <><span className="text-orange-300">{plural(t.findings, "difference")}</span> across {plural(t.roles_drifted, "role")}</>,
      detail: `${plural(t.drifted, "host")} ${t.drifted === 1 ? "carries" : "carry"} at least one; the other ${matching} match their role exactly.`
        + (t.updating ? ` ${t.updating} more are still updating.` : ""),
    };
  }
  return {
    pose: "checkmark",
    headline: "Every host matches its role",
    detail: `${t.reporting - t.updating} hosts in ${plural(t.distinct_states, "software state")} across ${roles}.`
      + (t.updating ? ` ${t.updating} more are still updating.` : ""),
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
      const k = h.cohort ?? h.puppet_role ?? "(unknown role)";
      m.set(k, [...(m.get(k) ?? []), h]);
    }
    return m;
  }, [data]);

  const t = data?.totals;
  const v = data && t && t.hosts > 0 ? verdict(data) : null;

  // The open configuration lives in the URL, so it can be linked and survives a reload.
  const [params, setParams] = useSearchParams();
  const configRole = data?.roles.find(r => r.key === params.get("config")) ?? null;
  const closeConfig = () => setParams(p => { p.delete("config"); return p; });

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
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-gray-600">
                <Legend cls="bg-brand-500/40" label="matches" />
                <Legend cls="bg-orange-400" label="drifted" />
                <Legend cls="bg-yellow-500/55" label="stale" />
                <Legend cls="bg-brand-500/15" label="updating" />
                <Legend cls="ring-1 ring-inset ring-gray-600/80" label="not reporting" />
              </div>
            </div>
          </div>

          <div className="card overflow-hidden">
            {[...FAMILIES.map(f => f.label), "Other"].map(label => {
              const roles = data.roles.filter(r => family(r.puppet_role) === label);
              if (!roles.length) return null;
              const hostCount = roles.reduce((n, r) => n + r.hosts, 0);
              const differences = roles.reduce((n, r) => n + r.findings.length, 0);
              return (
                <section key={label} className="border-t border-gray-800/70 first:border-t-0">
                  <div className="flex items-baseline gap-2 px-5 pt-4 pb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</span>
                    <span className="text-[11px] text-gray-600">
                      {plural(roles.length, "role")} · {plural(hostCount, "host")}
                      {differences > 0 && <span className="text-orange-300/80"> · {plural(differences, "difference")}</span>}
                    </span>
                  </div>
                  {roles.map(r => (
                    <RoleCard key={r.key} role={r} hosts={hostsByRole.get(r.key) ?? []} now={now}
                      onInspect={() => setParams(p => { p.set("config", r.key); return p; })} />
                  ))}
                </section>
              );
            })}
          </div>

          {configRole && <SbomConfigSheet key={configRole.puppet_role} role={configRole} onClose={closeConfig} />}

          <div className="text-[11px] text-gray-600 max-w-3xl space-y-1.5 -mt-2">
            <p className="flex items-start gap-1.5">
              <Package size={12} className="mt-0.5 flex-shrink-0" />
              <span>
                Covers the provisioned image: installer receipts, Xcode/CLT, pip packages, /usr/local/bin
                binaries and Homebrew. Toolchains a task fetches at run time aren't included. Each state
                downloads as CycloneDX 1.6.
              </span>
            </p>
            {data.uncovered.length > 0 && (
              <p className="pl-[18px]">
                Not covered:{" "}
                {Object.entries(
                  data.uncovered.reduce<Record<string, { pool: string; hosts: number }[]>>((acc, u) => {
                    (acc[u.reason] ??= []).push(u);
                    return acc;
                  }, {}),
                ).map(([reason, pools], i) => {
                  const n = pools.reduce((t, p) => t + p.hosts, 0);
                  return (
                    <span key={reason} title={pools.map(p => `${p.pool} (${p.hosts})`).join(", ")}>
                      {i > 0 && "; "}
                      <span className="text-gray-400 tabular-nums">{n}</span>{" "}
                      {pools.length === 1 ? <span className="font-mono">{pools[0].pool}</span> : <>hosts in {plural(pools.length, "pool")}</>}
                      {" "}({reason})
                    </span>
                  );
                })}
              </p>
            )}
          </div>
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
