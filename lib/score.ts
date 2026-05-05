import type { Finding, Severity } from "./types";

const WEIGHTS: Record<Severity, number> = {
  high: 9,
  med: 4,
  low: 1.5,
};

/** Compute a launch readiness score from 0..100. */
export function computeScore(findings: Finding[]): number {
  const penalty = findings.reduce((sum, f) => sum + WEIGHTS[f.sev], 0);
  // Floor at 25 so a hot mess still renders something usable; cap at 99 because
  // there's almost always something to find.
  return Math.max(25, Math.min(99, Math.round(100 - penalty)));
}

export function severityCount(findings: Finding[], sev: Severity): number {
  return findings.filter(f => f.sev === sev).length;
}

export function scoreLabel(score: number): { label: string; color: string } {
  if (score >= 85) return { label: "Ready to launch",   color: "var(--good)" };
  if (score >= 70) return { label: "Minor blockers",    color: "var(--med)" };
  if (score >= 55) return { label: "Needs attention",   color: "var(--accent)" };
  return                 { label: "Not launch-ready",   color: "var(--high)" };
}
