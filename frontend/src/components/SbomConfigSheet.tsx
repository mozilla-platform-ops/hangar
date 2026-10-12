import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Search, SquareTerminal, Hammer, FileCode2, Package, Beer, Apple, ChevronRight,
  ShieldCheck, Download, Check, LoaderCircle } from "lucide-react";
import { api } from "../api";
import type { SbomConfig, SbomItem, SbomRole } from "../api";

/**
 * What one software state actually is — the configuration of every host on it.
 *
 * A CycloneDX document is 600+ flat components, built for scanners. This reads it the
 * way a person asks: what OS and toolchain, which worker binaries and who signed them,
 * what Python carries. Identity facts lead in large type; everything else waits in
 * quiet sections behind one search field. Apple's own receipts fold into one line —
 * they are the OS, not the configuration.
 *
 * A sheet rather than a page, so the role list stays where you left it.
 */

const PREVIEW = 8;

function matches(item: SbomItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.name} ${item.version ?? ""} ${item.detail ?? ""}`.toLowerCase();
  return hay.includes(q);
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-brand-500/25 text-white rounded-[2px]">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Row({ item, q, icon }: { item: SbomItem; q: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-[7px]">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-gray-200 truncate flex items-center gap-1.5">
          <span className="truncate"><Highlight text={item.name} q={q} /></span>
          {icon}
        </div>
        {item.detail && <div className="text-[11px] text-gray-500 truncate mt-px"><Highlight text={item.detail} q={q} /></div>}
      </div>
      <div className="font-mono text-[12px] text-gray-400 tabular-nums whitespace-nowrap">
        {item.version && <Highlight text={item.version} q={q} />}
      </div>
    </div>
  );
}

/** Dense two-column list for long, uniform lists (Python packages). */
function Grid({ items, q }: { items: SbomItem[]; q: string }) {
  return (
    <div className="grid grid-cols-2 gap-x-6">
      {items.map(p => (
        <div key={p.name} className="flex items-baseline justify-between gap-2 py-[5px] border-b border-white/[0.03]">
          <span className="text-[12px] text-gray-300 truncate"><Highlight text={p.name} q={q} /></span>
          <span className="font-mono text-[11px] text-gray-500 tabular-nums whitespace-nowrap">
            {p.version ? <Highlight text={p.version} q={q} /> : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function Section({ icon, title, count, open, onToggle, children, summary }: {
  icon: React.ReactNode; title: string; count: number | string; open: boolean; onToggle: () => void;
  children: React.ReactNode; summary?: string;
}) {
  return (
    <section className="border-t border-white/[0.06]">
      <button onClick={onToggle} className="w-full flex items-center gap-3 py-3.5 text-left group">
        <span className="w-7 h-7 rounded-lg bg-white/[0.04] flex items-center justify-center text-gray-400 group-hover:text-gray-200 transition-colors">
          {icon}
        </span>
        <span className="flex-1 min-w-0">
          <span className="text-[14px] text-gray-100">{title}</span>
          {summary && !open && <span className="text-[12px] text-gray-600 ml-2">{summary}</span>}
        </span>
        <span className="text-[12px] text-gray-500 tabular-nums">{count}</span>
        <ChevronRight size={14} className={`text-gray-600 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="pb-4 pl-10">{children}</div>}
    </section>
  );
}

function MoreButton({ shown, total, onClick }: { shown: number; total: number; onClick: () => void }) {
  if (shown >= total) return null;
  return (
    <button onClick={onClick} className="mt-2 text-[12px] text-brand-300/90 hover:text-brand-200">
      Show all {total}
    </button>
  );
}

type Key = "binaries" | "devtools" | "python" | "packages" | "homebrew" | "apple";

export function SbomConfigSheet({ role, onClose }: { role: SbomRole; onClose: () => void }) {
  const [sha, setSha] = useState(role.modal_sha256 ?? role.states[0]?.sbom_sha256 ?? null);
  const [cfg, setCfg] = useState<SbomConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<Key, boolean>>({
    binaries: true, devtools: true, python: false, packages: false, homebrew: false, apple: false,
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  useEffect(() => { requestAnimationFrame(() => setShown(true)); }, []);
  useEffect(() => {
    if (!sha) return;
    setCfg(null); setErr(null);
    api.sbom.config(sha).then(setCfg).catch(e => setErr(String(e)));
  }, [sha]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (query) setQuery(""); else onClose(); }
      if (e.key === "/" && document.activeElement !== searchRef.current) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, onClose]);

  const f = useMemo(() => {
    if (!cfg) return null;
    const by = (xs: SbomItem[]) => xs.filter(x => matches(x, q));
    return {
      binaries: by(cfg.binaries),
      devtools: by(cfg.devtools),
      python: cfg.python.map(i => ({ ...i, packages: by(i.packages) })).filter(i => i.packages.length || !q),
      packages: by(cfg.packages),
      homebrew: by(cfg.homebrew),
      apple: by(cfg.apple_packages),
    };
  }, [cfg, q]);

  const isOpen = (k: Key) => (q ? true : open[k]);
  const toggle = (k: Key) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const limit = (key: string, xs: SbomItem[]) => (q || expanded[key] ? xs : xs.slice(0, PREVIEW));
  const more = (key: string) => () => setExpanded(e => ({ ...e, [key]: true }));
  const state = role.states.find(s => s.sbom_sha256 === sha);
  const signed = cfg ? cfg.binaries.filter(b => b.signed).length : 0;
  const pyCount = f ? f.python.reduce((n, i) => n + i.packages.length, 0) : 0;
  const nothing = f && q && !f.binaries.length && !f.devtools.length && !pyCount && !f.packages.length && !f.homebrew.length && !f.apple.length;

  // Portalled: the page's entrance animation leaves a transform on an ancestor, which
  // would make `fixed` relative to it instead of the viewport.
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`${role.puppet_role} configuration`}>
      <div onClick={onClose}
        className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity duration-300 motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`} />
      <aside
        className={`absolute right-0 top-0 h-full w-full max-w-[640px] bg-[#0b0f17]/[0.97] backdrop-blur-xl border-l border-white/[0.07]
          shadow-[-24px_0_80px_rgba(0,0,0,0.5)] flex flex-col
          transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none
          ${shown ? "translate-x-0" : "translate-x-full"}`}>

        {/* Header */}
        <div className="px-8 pt-7 pb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.12em] text-gray-500">Configuration</div>
              <h2 className="font-mono text-[19px] text-white mt-1.5 truncate">{role.puppet_role}</h2>
              <div className="text-[12px] text-gray-500 mt-1">
                {state ? <>{state.hosts} {state.hosts === 1 ? "host" : "hosts"} on this state</> : null}
                {cfg && <> · {cfg.component_count} components</>}
              </div>
            </div>
            <button onClick={onClose} aria-label="Close"
              className="w-8 h-8 -mr-2 rounded-full flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/[0.06] transition-colors">
              <X size={16} />
            </button>
          </div>

          {role.states.length > 1 && (
            <div className="inline-flex mt-4 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.05]">
              {role.states.map(s => {
                const active = s.sbom_sha256 === sha;
                const baseline = s.sbom_sha256 === role.modal_sha256;
                return (
                  <button key={s.sbom_sha256} onClick={() => setSha(s.sbom_sha256)} disabled={!s.document}
                    title={s.document ? s.sbom_sha256 : "document not collected yet"}
                    className={`px-3 py-1 rounded-md text-[12px] transition-colors disabled:opacity-40 ${
                      active ? "bg-white/[0.09] text-white shadow-sm" : "text-gray-500 hover:text-gray-200"}`}>
                    {baseline ? "Baseline" : <span className="font-mono">{s.sbom_sha256.slice(0, 7)}</span>}
                    <span className="text-gray-600 ml-1.5 tabular-nums">{s.hosts}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-8 pb-8">
          {err && <div className="text-sm text-gray-500 py-8">Couldn't load this configuration: {err}</div>}
          {!cfg && !err && (
            <div className="py-16 flex justify-center text-gray-600"><LoaderCircle size={18} className="animate-spin" /></div>
          )}

          {cfg && f && (
            <>
              {/* At a glance */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-5 py-5 border-y border-white/[0.06] mb-5">
                {cfg.glance.map((g, i) => (
                  <div key={g.label} className={`min-w-0 ${i % 4 ? "sm:border-l sm:border-white/[0.06] sm:pl-5" : ""}`}>
                    <div className="text-[11px] text-gray-500">{g.label}</div>
                    <div className="text-[26px] leading-none font-light text-white tabular-nums mt-2 truncate">{g.value ?? "—"}</div>
                    {g.detail && <div className="text-[11px] text-gray-500 mt-1.5 truncate">{g.detail}</div>}
                  </div>
                ))}
              </div>

              {/* One field searches everything */}
              <label className="relative block mb-2">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)}
                  placeholder={`Search ${cfg.component_count} components`}
                  className="w-full h-9 rounded-lg bg-white/[0.04] border border-white/[0.06] pl-9 pr-10 text-[13px] text-gray-100
                    placeholder:text-gray-600 outline-none focus:border-brand-500/50 focus:bg-white/[0.06] transition-colors" />
                <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-600 border border-white/[0.08] rounded px-1.5 py-px">/</kbd>
              </label>

              {nothing && <div className="text-[13px] text-gray-500 py-10 text-center">Nothing installed matches “{query.trim()}”.</div>}

              {(!q || f.binaries.length > 0) && (
                <Section icon={<SquareTerminal size={14} />} title="Binaries" count={f.binaries.length}
                  summary={`/usr/local/bin${signed ? ` · ${signed} signed` : ""}`} open={isOpen("binaries")} onToggle={() => toggle("binaries")}>
                  {limit("binaries", f.binaries).map(b => (
                    <Row key={b.name} item={b} q={q}
                      icon={b.signed ? <ShieldCheck size={12} className="text-emerald-400/80 flex-shrink-0" aria-label="signed" /> : undefined} />
                  ))}
                  {!q && <MoreButton shown={expanded.binaries ? f.binaries.length : PREVIEW} total={f.binaries.length} onClick={more("binaries")} />}
                </Section>
              )}

              {(!q || f.devtools.length > 0) && (
                <Section icon={<Hammer size={14} />} title="Developer tools" count={f.devtools.length || "None"}
                  open={isOpen("devtools")} onToggle={() => toggle("devtools")}>
                  {f.devtools.length ? f.devtools.map(d => <Row key={`${d.name}${d.version}`} item={d} q={q} />)
                    : <div className="text-[12px] text-gray-500 py-1">No Xcode or Command Line Tools.</div>}
                </Section>
              )}

              {(!q || pyCount > 0) && f.python.length > 0 && (
                <Section icon={<FileCode2 size={14} />} title="Python" count={pyCount}
                  summary={f.python.map(i => i.label).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
                  open={isOpen("python")} onToggle={() => toggle("python")}>
                  <div className="space-y-5">
                    {f.python.map(i => (
                      <div key={i.path}>
                        <div className="flex items-baseline gap-2 mb-1.5">
                          <span className="text-[12px] text-gray-300">{i.label}</span>
                          <span className="font-mono text-[11px] text-gray-600 truncate">{i.path}</span>
                          <span className="ml-auto text-[11px] text-gray-600 tabular-nums">{i.packages.length}</span>
                        </div>
                        <Grid items={limit(`py:${i.path}`, i.packages)} q={q} />
                        {!q && <MoreButton shown={expanded[`py:${i.path}`] ? i.packages.length : PREVIEW} total={i.packages.length} onClick={more(`py:${i.path}`)} />}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {(!q || f.packages.length > 0) && (
                <Section icon={<Package size={14} />} title="Installed packages" count={f.packages.length}
                  open={isOpen("packages")} onToggle={() => toggle("packages")}>
                  {limit("packages", f.packages).map(p => <Row key={p.name} item={p} q={q} />)}
                  {!q && <MoreButton shown={expanded.packages ? f.packages.length : PREVIEW} total={f.packages.length} onClick={more("packages")} />}
                </Section>
              )}

              {(!q || f.homebrew.length > 0) && (
                <Section icon={<Beer size={14} />} title="Homebrew" count={f.homebrew.length || "None"}
                  open={isOpen("homebrew")} onToggle={() => toggle("homebrew")}>
                  {f.homebrew.length ? (
                    <>
                      {limit("homebrew", f.homebrew).map(b => <Row key={`${b.detail}${b.name}`} item={b} q={q} />)}
                      {!q && <MoreButton shown={expanded.homebrew ? f.homebrew.length : PREVIEW} total={f.homebrew.length} onClick={more("homebrew")} />}
                    </>
                  ) : (
                    <div className="text-[12px] text-gray-500 py-1 flex items-center gap-1.5">
                      <Check size={12} className="text-emerald-400/80" /> Not installed
                    </div>
                  )}
                </Section>
              )}

              {(!q || f.apple.length > 0) && f.apple.length > 0 && (
                <Section icon={<Apple size={14} />} title="Apple system packages" count={f.apple.length}
                  summary="part of macOS" open={isOpen("apple")} onToggle={() => toggle("apple")}>
                  {limit("apple", f.apple).map(p => <Row key={p.name} item={p} q={q} />)}
                  {!q && <MoreButton shown={expanded.apple ? f.apple.length : PREVIEW} total={f.apple.length} onClick={more("apple")} />}
                </Section>
              )}

              <div className="border-t border-white/[0.06] pt-5 mt-1 flex items-center justify-between gap-4">
                <div className="text-[11px] text-gray-600 min-w-0">
                  <span className="font-mono">{cfg.sha256.slice(0, 16)}</span>
                  {cfg.os.sip && <> · SIP {cfg.os.sip}</>}
                  {cfg.os.arch && <> · {cfg.os.arch}</>}
                </div>
                <a href={api.sbom.documentUrl(cfg.sha256)}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] text-gray-200 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.06] transition-colors whitespace-nowrap">
                  <Download size={13} /> CycloneDX
                </a>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
