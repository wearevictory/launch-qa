"use client";

import { useEffect, useRef, useState } from "react";
import type { Finding, ScanJob, ScanResult } from "@/lib/types";
import { CATEGORY_META } from "@/lib/types";
import { scoreLabel } from "@/lib/score";
import { buildMarkdownReport, clientSummaryText } from "@/lib/markdown";

type View = "summary" | "findings" | "fixes" | "client" | "dev" | "manual";
type Status = "idle" | "pending" | "running" | "done" | "error";

interface ManualItem { id: string; text: string; done: boolean; }

const POLL_INTERVAL_MS = 2000;

export default function Page() {
  const [url, setUrl] = useState("");
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("summary");
  const [manualItems, setManualItems] = useState<ManualItem[]>([]);
  const [newItem, setNewItem] = useState("");

  const reportRef = useRef<HTMLDivElement>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  async function startScan(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setStatus("pending");
    setProgress(0);
    setStage("Queuing");
    setError(null);
    setScan(null);

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), project: project.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const { id } = (await res.json()) as { id: string };
      pollJob(id);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function pollJob(id: string) {
    if (pollTimer.current) clearInterval(pollTimer.current);
    const tick = async () => {
      try {
        const res = await fetch(`/api/scan/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const job = (await res.json()) as ScanJob;
        setStatus(job.status);
        setProgress(job.progress);
        setStage(job.stage);
        if (job.status === "done") {
          if (pollTimer.current) clearInterval(pollTimer.current);
          if (job.result) {
            setScan(job.result);
            setView("summary");
            setTimeout(() => {
              reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 80);
          }
        } else if (job.status === "error") {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setError(job.error || "Scan failed");
        }
      } catch (err) {
        if (pollTimer.current) clearInterval(pollTimer.current);
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    pollTimer.current = setInterval(tick, POLL_INTERVAL_MS);
  }

  function reset() {
    if (pollTimer.current) clearInterval(pollTimer.current);
    setStatus("idle");
    setProgress(0);
    setStage("");
    setScan(null);
    setError(null);
    setManualItems([]);
    setUrl("");
    setProject("");
    setView("summary");
  }

  function addManual() {
    const text = newItem.trim();
    if (!text) return;
    setManualItems(prev => [
      ...prev,
      { id: Math.random().toString(36).slice(2, 9), text, done: false },
    ]);
    setNewItem("");
  }
  function toggleManual(id: string) {
    setManualItems(prev => prev.map(i => (i.id === id ? { ...i, done: !i.done } : i)));
  }
  function removeManual(id: string) {
    setManualItems(prev => prev.filter(i => i.id !== id));
  }

  function exportMarkdown() {
    if (!scan) return;
    const md = buildMarkdownReport(scan, manualItems, project);
    const safe = (project || "launch-qa")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "launch-qa";
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safe}-report.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const isBusy = status === "pending" || status === "running";

  return (
    <>
      <header className="topbar no-print">
        <div className="container">
          <div className="topbar-inner">
            <div className="logo">
              <div className="logo-mark">Q</div>
              <div className="logo-text">
                <div className="name">Launch QA</div>
                <div className="sub">PRE-FLIGHT FOR THE WEB</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>v0.1 · MVP</div>
          </div>
        </div>
      </header>

      <main className="container">
        <section className="hero no-print">
          <div>
            <div className="chip">Pre-launch audit</div>
            <h1 className="display">
              Catch the launch-day issues<br />before launch day.
            </h1>
            <p className="lede">
              Drop in a staging URL and get a structured QA report — SEO, accessibility,
              links, mobile, copy, and performance — in seconds.
            </p>
          </div>
          <form onSubmit={startScan} className="card form-card" autoComplete="off">
            <div className="form-row">
              <label className="chip">Project</label>
              <input
                type="text"
                className="input"
                placeholder="Optional — e.g. Allbirds Holiday"
                value={project}
                onChange={e => setProject(e.target.value)}
                disabled={isBusy}
              />
            </div>
            <div className="form-row">
              <label className="chip">Staging URL</label>
              <input
                type="text"
                className="input"
                placeholder="https://staging.client.com"
                value={url}
                onChange={e => setUrl(e.target.value)}
                disabled={isBusy}
                required
              />
            </div>
            <div className="btn-row">
              <button type="submit" className="btn btn-primary" disabled={isBusy}>
                {isBusy ? "Scanning…" : "Run QA scan"}
              </button>
              {status === "done" && (
                <button type="button" className="btn btn-ghost" onClick={reset}>
                  New scan
                </button>
              )}
            </div>
            {isBusy && (
              <>
                <div className="progress">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="scanning-text">
                  {stage || "Auditing the site…"}
                </div>
              </>
            )}
            {status === "error" && error && (
              <div className="error-banner">
                <strong>Scan failed.</strong> {error}
              </div>
            )}
          </form>
        </section>

        {status === "idle" && <IdleSteps />}

        {status === "done" && scan && (
          <div ref={reportRef} className="mt-12">
            <Report
              scan={scan}
              project={project}
              view={view}
              onView={setView}
              manualItems={manualItems}
              newItem={newItem}
              setNewItem={setNewItem}
              addManual={addManual}
              toggleManual={toggleManual}
              removeManual={removeManual}
              exportMarkdown={exportMarkdown}
            />
          </div>
        )}
      </main>

      <footer className="bottombar no-print">
        <div className="container">
          <div className="bottombar-inner">
            <div>Launch QA Assistant — MVP</div>
            <div>Real audits via Playwright + Lighthouse + axe-core</div>
          </div>
        </div>
      </footer>
    </>
  );
}

function IdleSteps() {
  const steps = [
    { num: "01", title: "Paste staging URL", body: "Or any link you'd like a structured pre-launch read on." },
    { num: "02", title: "We audit it for real", body: "Headless browser + Lighthouse + axe-core + custom DOM checks." },
    { num: "03", title: "Share with the team", body: "Export as Markdown or hand off the dev checklist." },
  ];
  return (
    <section className="no-print">
      <div className="divider-dotted" />
      <div className="steps">
        {steps.map(s => (
          <div className="step" key={s.num}>
            <div className="num">{s.num}</div>
            <div className="title">{s.title}</div>
            <div className="body">{s.body}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface ReportProps {
  scan: ScanResult;
  project: string;
  view: View;
  onView: (v: View) => void;
  manualItems: ManualItem[];
  newItem: string;
  setNewItem: (v: string) => void;
  addManual: () => void;
  toggleManual: (id: string) => void;
  removeManual: (id: string) => void;
  exportMarkdown: () => void;
}

function Report(p: ReportProps) {
  const { scan, project, view, onView } = p;
  const findings = scan.findings;
  const high = findings.filter(f => f.sev === "high");
  const med = findings.filter(f => f.sev === "med");
  const low = findings.filter(f => f.sev === "low");
  const prio = [...high, ...med, ...low];

  const tabs: { id: View; label: string }[] = [
    { id: "summary", label: "Summary" },
    { id: "findings", label: `Findings (${findings.length})` },
    { id: "fixes", label: "Recommended fixes" },
    { id: "client", label: "Client summary" },
    { id: "dev", label: "Dev checklist" },
    { id: "manual", label: `Manual QA (${p.manualItems.length})` },
  ];

  return (
    <>
      <div className="card">
        <div className="report-header">
          <div>
            <div className="chip">Report</div>
            <div className="report-title">{project || "Untitled project"}</div>
            <div className="report-url">{scan.finalUrl || scan.url}</div>
            <div className="report-time">
              Scanned {new Date(scan.scannedAt).toLocaleString()} · {(scan.durationMs / 1000).toFixed(1)}s
            </div>
          </div>
          <ScoreRing score={scan.score} />
        </div>

        <div className="severity-row">
          <SevCell label="High" count={high.length} dotCls="dot-high" />
          <SevCell label="Medium" count={med.length} dotCls="dot-med" />
          <SevCell label="Low" count={low.length} dotCls="dot-low" />
        </div>

        {scan.lighthouse && (
          <div className="lh-strip">
            <LhCell label="Performance" value={scan.lighthouse.performance} />
            <LhCell label="SEO" value={scan.lighthouse.seo} />
            <LhCell label="Accessibility" value={scan.lighthouse.accessibility} />
            <LhCell label="Best Practices" value={scan.lighthouse.bestPractices} />
          </div>
        )}

        <div className="report-actions no-print">
          <button className="btn btn-ghost" onClick={p.exportMarkdown}>↓ Export Markdown</button>
          <button className="btn btn-ghost" onClick={() => window.print()}>↗ Print / save PDF</button>
        </div>
      </div>

      <div className="tabs no-print">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`tab${view === t.id ? " active" : ""}`}
            onClick={() => onView(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {view === "summary" && <SummaryTab scan={scan} prio={prio} high={high} med={med} low={low} />}
        {view === "findings" && <FindingsTab prio={prio} />}
        {view === "fixes" && <FixesTab prio={prio} />}
        {view === "client" && <ClientTab scan={scan} prio={prio} />}
        {view === "dev" && <DevTab prio={prio} />}
        {view === "manual" && (
          <ManualTab
            items={p.manualItems}
            newItem={p.newItem}
            setNewItem={p.setNewItem}
            addManual={p.addManual}
            toggleManual={p.toggleManual}
            removeManual={p.removeManual}
          />
        )}
      </div>
    </>
  );
}

function SevCell({ label, count, dotCls }: { label: string; count: number; dotCls: string }) {
  return (
    <div className="sev-cell">
      <span className={`dot ${dotCls}`} />
      <div>
        <div className="n">{count}</div>
        <div className="chip" style={{ marginTop: 4 }}>{label} severity</div>
      </div>
    </div>
  );
}

function LhCell({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="lh-cell">
      <span className="lh-num">{value == null ? "—" : value}</span>
      <span className="lh-label">{label}</span>
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = c * pct;
  const sl = scoreLabel(score);
  return (
    <div className="score-wrap">
      <div style={{ position: "relative", width: 130, height: 130 }}>
        <svg className="score-ring-svg" width="130" height="130">
          <circle cx="65" cy="65" r={r} stroke="var(--line)" strokeWidth="6" fill="none" />
          <circle cx="65" cy="65" r={r} stroke={sl.color} strokeWidth="6" fill="none"
                  strokeDasharray={`${dash} ${c - dash}`} strokeLinecap="round" />
        </svg>
        <div className="score-ring-num">
          <div className="n">{score}</div>
          <div className="d">/ 100</div>
        </div>
      </div>
      <div>
        <div className="chip">Launch readiness</div>
        <div className="score-status" style={{ color: sl.color }}>{sl.label}</div>
        <div className="score-help">
          Score weighs high-severity issues most heavily; aim for 85+ before go-live.
        </div>
      </div>
    </div>
  );
}

function SummaryTab({ scan, prio, high, med, low }: { scan: ScanResult; prio: Finding[]; high: Finding[]; med: Finding[]; low: Finding[] }) {
  const sl = scoreLabel(scan.score);
  const blockerLine = high.length > 0
    ? `${high.length === 1 ? " The high-severity item is" : " High-severity items are"} considered launch blockers and should be resolved before go-live.`
    : " No launch blockers detected — recommended fixes are polish-grade.";

  return (
    <div className="grid-2-1">
      <div className="card">
        <div className="section-header">
          <div className="chip">Executive summary</div>
          <div className="title">What we found</div>
        </div>
        <p className="ink-2" style={{ lineHeight: 1.65 }}>
          We audited <span className="ink" style={{ fontWeight: 500 }}>{scan.finalUrl || scan.url}</span> across six categories.
          The build scored <span className="ink" style={{ fontWeight: 500 }}>{scan.score}/100</span> — {sl.label.toLowerCase()}.
          We surfaced <span className="ink" style={{ fontWeight: 500 }}>{high.length} high</span>,
          {" "}{med.length} medium, and {low.length} low-severity findings.
          {blockerLine}
        </p>
        <div className="divider-dotted" />
        <div className="section-header">
          <div className="chip">Top concerns</div>
          <div className="title">Three things to fix first</div>
        </div>
        <ol className="top-list">
          {prio.slice(0, 3).map((f, i) => (
            <li key={f.id}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <div className="what">{f.title}</div>
                <div className="how">{f.fix}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="card">
        <div className="section-header">
          <div className="chip">By category</div>
          <div className="title">Where the issues live</div>
        </div>
        <CategoryBreakdown findings={scan.findings} />
      </div>
    </div>
  );
}

function CategoryBreakdown({ findings }: { findings: Finding[] }) {
  const cats = (Object.keys(CATEGORY_META) as (keyof typeof CATEGORY_META)[]).map(cat => {
    const items = findings.filter(f => f.category === cat);
    return {
      cat,
      total: items.length,
      high: items.filter(i => i.sev === "high").length,
      med: items.filter(i => i.sev === "med").length,
      low: items.filter(i => i.sev === "low").length,
    };
  });
  const max = Math.max(1, ...cats.map(c => c.total));
  return (
    <div className="cat-grid">
      {cats.map(c => (
        <div key={c.cat}>
          <div className="cat-row-head">
            <div>
              <div className="cat-name">{CATEGORY_META[c.cat].label}</div>
              <div className="cat-blurb">{CATEGORY_META[c.cat].blurb}</div>
            </div>
            <div className="cat-count">
              {c.total} {c.total === 1 ? "issue" : "issues"}
            </div>
          </div>
          <div className="cat-bar">
            <span className="dot-high" style={{ width: `${(c.high / max) * 100}%` }} />
            <span className="dot-med" style={{ width: `${(c.med / max) * 100}%` }} />
            <span className="dot-low" style={{ width: `${(c.low / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SeverityBadge({ sev }: { sev: Finding["sev"] }) {
  const cls = sev === "high" ? "badge-high" : sev === "med" ? "badge-med" : "badge-low";
  const label = sev === "high" ? "High" : sev === "med" ? "Medium" : "Low";
  return <span className={`badge ${cls}`}>{label}</span>;
}

function FindingsTab({ prio }: { prio: Finding[] }) {
  return (
    <div className="card findings">
      <div className="section-header-row">
        <div>
          <div className="chip">All findings</div>
          <div style={{ fontFamily: "Fraunces, serif", fontSize: 22, marginTop: 4, fontWeight: 500 }}>
            {prio.length} items, sorted by severity
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          Click a finding to see the recommended fix
        </div>
      </div>
      {prio.map(f => (
        <details key={f.id}>
          <summary>
            <span style={{ marginTop: 4, flexShrink: 0 }}>
              <SeverityBadge sev={f.sev} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="find-meta">
                <span className="find-title">{f.title}</span>
                <span className="chip">{CATEGORY_META[f.category].label}</span>
                {f.source && <span className="chip" style={{ color: "var(--muted)" }}>via {f.source}</span>}
              </div>
              <div className="find-detail">{f.detail}</div>
              {f.evidence && <div className="find-evidence">{f.evidence}</div>}
            </div>
            <span className="find-toggle">+</span>
          </summary>
          <div className="find-body">
            <div className="fix-card">
              <div className="label">Recommended fix</div>
              <div className="text">{f.fix}</div>
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}

function FixesTab({ prio }: { prio: Finding[] }) {
  return (
    <div className="card">
      <div className="section-header">
        <div className="chip">Recommended fixes</div>
        <div className="title">In priority order</div>
      </div>
      <ol className="fixes-list">
        {prio.map((f, i) => (
          <li key={f.id}>
            <div className="fix-num">{String(i + 1).padStart(2, "0")}</div>
            <div style={{ flex: 1 }}>
              <div className="fix-meta">
                <SeverityBadge sev={f.sev} />
                <span className="chip">{CATEGORY_META[f.category].label}</span>
              </div>
              <div className="fix-title">{f.title}</div>
              <div className="fix-text">{f.fix}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ClientTab({ scan, prio }: { scan: ScanResult; prio: Finding[] }) {
  return (
    <div className="card client-card">
      <div className="section-header">
        <div className="chip">Client-friendly summary</div>
        <div className="title">Plain-language status</div>
      </div>
      <p>{clientSummaryText(scan)}</p>
      <p>Highlights of what we&apos;re addressing this week:</p>
      <ul className="client-list">
        {prio.slice(0, 5).map(f => (
          <li key={f.id}>
            <span className="bullet">•</span>
            <span>{f.title}</span>
          </li>
        ))}
      </ul>
      <p>
        We&apos;ll share an updated build once these are resolved and run a final
        pre-flight pass before launch.
      </p>
    </div>
  );
}

function DevTab({ prio }: { prio: Finding[] }) {
  const text = prio
    .map(f => `- [ ] [${f.sev.toUpperCase()}] [${CATEGORY_META[f.category].label}] ${f.title}\n        Fix: ${f.fix}`)
    .join("\n\n");
  return (
    <div className="card">
      <div className="section-header">
        <div className="chip">Developer checklist</div>
        <div className="title">Copy into your tracker</div>
      </div>
      <pre className="dev-pre">{text}</pre>
    </div>
  );
}

interface ManualTabProps {
  items: ManualItem[];
  newItem: string;
  setNewItem: (v: string) => void;
  addManual: () => void;
  toggleManual: (id: string) => void;
  removeManual: (id: string) => void;
}
function ManualTab({ items, newItem, setNewItem, addManual, toggleManual, removeManual }: ManualTabProps) {
  return (
    <div className="card manual-card">
      <div className="section-header">
        <div className="chip">Manual QA</div>
        <div className="title">Add your own checks</div>
      </div>
      <p style={{ fontSize: 14, color: "var(--ink-2)", margin: "0 0 20px" }}>
        Capture anything the auto-scan can&apos;t — visual polish, brand voice nits,
        animation timing, anything a human eye catches.
      </p>
      <div className="manual-input-row no-print">
        <input
          type="text"
          className="input"
          placeholder="e.g. Hero animation timing feels off on first load"
          value={newItem}
          onChange={e => setNewItem(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              addManual();
            }
          }}
        />
        <button className="btn btn-primary" onClick={addManual}>Add</button>
      </div>
      <div className="manual-list">
        {items.length === 0 ? (
          <div className="manual-empty">No manual items yet. Add the first above.</div>
        ) : (
          items.map(i => (
            <label key={i.id} className={`manual-item${i.done ? " done" : ""}`}>
              <input
                type="checkbox"
                checked={i.done}
                onChange={() => toggleManual(i.id)}
              />
              <span className="text">{i.text}</span>
              <button
                className="manual-remove no-print"
                onClick={() => removeManual(i.id)}
              >Remove</button>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
