import { useEffect, useState, type ReactNode } from "react";
import { Package, Server, GitCommit, ExternalLink, ArrowRight, AlertTriangle,
  CircleDot, LoaderCircle, CheckCircle2, XCircle, Rocket } from "lucide-react";
import { api } from "../api";
import type { VMPipeline, VMPipelineRun } from "../api";
import { usePoll, useNow } from "../lib/useLive";
import { Badge } from "./Badge";

/** "x ago" from an ISO timestamp. */
function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const diff = now - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}

/** Colour + label for a GitHub Actions run's outcome. */
function runBadge(run: VMPipelineRun | null) {
  if (!run) return <Badge label="no run" variant="gray" />;
  if (run.status && run.status !== "completed") {
    const label = run.status === "in_progress" ? "building" : run.status;
    return <Badge label={label} variant="blue" dot pulse />;
  }
  switch (run.conclusion) {
    case "success": return <Badge label="success" variant="green" dot />;
    case "failure": return <Badge label="failed" variant="red" dot />;
    case "cancelled": return <Badge label="cancelled" variant="gray" dot />;
    default: return <Badge label={run.conclusion || "unknown"} variant="yellow" dot />;
  }
}

function RunIcon({ run }: { run: VMPipelineRun | null }) {
  if (run && run.status && run.status !== "completed")
    return <LoaderCircle size={14} className="text-blue-400 animate-spin" />;
  if (run?.conclusion === "success") return <CheckCircle2 size={14} className="text-emerald-400" />;
  if (run?.conclusion === "failure") return <XCircle size={14} className="text-red-400" />;
  return <CircleDot size={14} className="text-gray-500" />;
}

export function VMImagePipelineCard() {
  const [data, setData] = useState<VMPipeline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(30_000);

  const load = () => api.vmPipeline.get().then(setData).catch(e => setErr(String(e)));
  useEffect(() => { load(); }, []);
  usePoll(load, 60_000);

  if (err && !data) {
    return (
      <div className="card p-5">
        <Header repoUrl={null} generatedAt={null} now={now} />
        <div className="text-xs text-gray-600 py-4">Couldn't load the VM image pipeline: {err}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card p-5">
        <Header repoUrl={null} generatedAt={null} now={now} />
        <div className="text-xs text-gray-600 py-6 flex items-center gap-2">
          <LoaderCircle size={13} className="animate-spin" /> Loading pipeline…
        </div>
      </div>
    );
  }

  const { registry, current, latest_run, history, rollout, repo_url } = data;
  // Show the latest run as its own strip only when it isn't already the shipped image
  // (i.e. an in-flight or failed build that hasn't promoted to prod-latest).
  const latestIsCurrent = !!(latest_run && current.sha && latest_run.sha === current.sha
    && latest_run.conclusion === "success");
  const showLatest = latest_run && !latestIsCurrent;

  return (
    <div className="card p-5">
      <Header repoUrl={repo_url} generatedAt={data.generated_at} now={now} />

      {/* Three-stage flow: Build → Registry (prod-latest) → Rollout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-3 lg:gap-2">
        {/* Build */}
        <Stage icon={<GitCommit size={13} />} label="Build">
          {latest_run ? (
            <a href={latest_run.url ?? repo_url} target="_blank" rel="noopener noreferrer"
              className="block group">
              <div className="flex items-center gap-2">
                <RunIcon run={latest_run} />
                <span className="text-sm font-mono text-gray-200 group-hover:text-white">
                  #{latest_run.run_number}
                </span>
                {runBadge(latest_run)}
              </div>
              <div className="text-[11px] text-gray-500 mt-1 truncate" title={latest_run.title ?? ""}>
                {latest_run.short_sha ? <span className="font-mono">{latest_run.short_sha}</span> : null}
                {latest_run.actor ? <> · {latest_run.actor}</> : null} · {ago(latest_run.created_at, now)}
              </div>
            </a>
          ) : <div className="text-[11px] text-gray-600">No recent runs.</div>}
        </Stage>

        <Arrow />

        {/* Registry — current prod-latest */}
        <Stage icon={<Package size={13} />} label="prod-latest">
          {registry.reachable ? (
            current.digest_short ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono text-emerald-300">{current.digest_short}</span>
                  <Badge label="live" variant="green" dot pulse />
                </div>
                <div className="text-[11px] text-gray-500 mt-1">
                  {current.short_sha ? (
                    <a href={current.run?.url ?? repo_url} target="_blank" rel="noopener noreferrer"
                      className="font-mono hover:text-gray-300">{current.short_sha}</a>
                  ) : "unmatched commit"}
                  {current.built_at ? <> · built {ago(current.built_at, now)}</> : null}
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-mono text-gray-300">
                  {registry.prod_latest_digest_short ?? "—"}
                </div>
                <div className="text-[11px] text-gray-500 mt-1">
                  {registry.prod_latest_digest_short ? "commit not matched to a run" : "no prod-latest tag"}
                </div>
              </>
            )
          ) : (
            <div className="flex items-center gap-1.5 text-[11px] text-orange-300/90">
              <AlertTriangle size={12} /> registry unreachable
            </div>
          )}
        </Stage>

        <Arrow />

        {/* Rollout */}
        <Stage icon={<Server size={13} />} label="Rollout">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold text-gray-100 tabular-nums leading-none">{rollout.vm_worker_count}</span>
            <span className="text-[11px] text-gray-500">VM workers</span>
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            <span className="text-emerald-400">{rollout.active_24h}</span> active (24h)
            {!rollout.digest_drift_instrumented && (
              <span title={rollout.note} className="text-gray-600"> · drift n/a</span>
            )}
          </div>
        </Stage>
      </div>

      {/* In-flight / failed latest build banner */}
      {showLatest && latest_run && (
        <div className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[11px] ring-1 ring-inset ${
          latest_run.conclusion === "failure"
            ? "bg-red-950/40 text-red-200 ring-red-500/20"
            : latest_run.status !== "completed"
              ? "bg-blue-950/40 text-blue-200 ring-blue-500/20"
              : "bg-gray-900/40 text-gray-300 ring-gray-700/30"}`}>
          <RunIcon run={latest_run} />
          <span className="font-medium">
            Latest build #{latest_run.run_number} {latest_run.status !== "completed" ? "in progress" : latest_run.conclusion}
          </span>
          <span className="text-gray-400 truncate flex-1" title={latest_run.title ?? ""}>— {latest_run.title}</span>
          {latest_run.url && (
            <a href={latest_run.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-0.5 text-current/80 hover:underline flex-shrink-0">
              logs <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}

      {/* Recent builds */}
      {history.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-800/60">
          <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Recent builds</div>
          <div className="space-y-1">
            {history.slice(0, 6).map(b => (
              <div key={b.tag} className="flex items-center gap-3 text-[11px]">
                <RunIcon run={b.run} />
                <a href={b.run?.url ?? `${repo_url}/commit/${b.sha}`} target="_blank" rel="noopener noreferrer"
                  className="font-mono text-gray-400 hover:text-gray-200 w-16 flex-shrink-0">{b.short_sha}</a>
                <span className="font-mono text-gray-600 w-28 flex-shrink-0 truncate" title={b.digest ?? ""}>
                  {b.digest_short ?? "—"}
                </span>
                <span className="flex-1">{runBadge(b.run)}</span>
                {b.is_current && <Badge label="current" variant="green" />}
                <span className="text-gray-600 w-16 text-right flex-shrink-0">{ago(b.built_at, now)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer: registry + freshness */}
      <div className="mt-4 flex items-center justify-between text-[10px] text-gray-600">
        <span className="font-mono truncate" title={registry.url}>
          {registry.repo} @ {registry.url.replace(/^https?:\/\//, "")}
          {registry.tag_count != null ? ` · ${registry.tag_count} tags` : ""}
        </span>
        <span>updated {ago(data.generated_at, now)}</span>
      </div>
    </div>
  );
}

function Header({ repoUrl, generatedAt, now }: { repoUrl: string | null; generatedAt: string | null; now: number }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
        <Rocket size={13} className="text-gray-500" /> VM Image Pipeline
        <span className="flex items-center gap-1 text-[10px] text-gray-600 normal-case tracking-normal font-normal">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> live
        </span>
      </h3>
      {repoUrl && (
        <a href={repoUrl} target="_blank" rel="noopener noreferrer"
          className="text-[11px] text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1">
          macos-vms <ExternalLink size={12} />
        </a>
      )}
      {!repoUrl && generatedAt && <span className="text-[10px] text-gray-600">updated {ago(generatedAt, now)}</span>}
    </div>
  );
}

function Stage({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-gray-900/40 ring-1 ring-inset ring-gray-800/60 px-3 py-2.5">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-1.5">
        <span className="text-gray-600">{icon}</span>{label}
      </div>
      {children}
    </div>
  );
}

function Arrow() {
  return (
    <div className="hidden lg:flex items-center justify-center text-gray-700">
      <ArrowRight size={16} />
    </div>
  );
}
