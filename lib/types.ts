export type Severity = "high" | "med" | "low";

export type Category =
  | "SEO"
  | "Accessibility"
  | "Links"
  | "Mobile"
  | "CopyBrand"
  | "Performance";

export interface Finding {
  id: string;
  category: Category;
  sev: Severity;
  title: string;
  detail: string;
  fix: string;
  /** Optional source attribution: "lighthouse", "axe", or our custom check id. */
  source?: string;
  /** Optional code snippet or selector pointing at the issue. */
  evidence?: string;
}

export interface ScanResult {
  url: string;
  finalUrl?: string;
  scannedAt: string; // ISO
  durationMs: number;
  score: number;
  findings: Finding[];
  /** Lighthouse top-line scores (0-100), if Lighthouse ran. */
  lighthouse?: {
    performance: number | null;
    seo: number | null;
    accessibility: number | null;
    bestPractices: number | null;
  };
}

export interface ScanJob {
  id: string;
  url: string;
  project?: string;
  status: "pending" | "running" | "done" | "error";
  progress: number; // 0..100
  stage: string;    // human-readable current step
  startedAt: string;
  finishedAt?: string;
  result?: ScanResult;
  error?: string;
}

export const CATEGORY_META: Record<Category, { label: string; blurb: string }> = {
  SEO:           { label: "SEO",            blurb: "Search visibility & metadata" },
  Accessibility: { label: "Accessibility",  blurb: "WCAG 2.1 AA conformance risks" },
  Links:         { label: "Links & CTAs",   blurb: "Hrefs, buttons, and routing" },
  Mobile:        { label: "Mobile QA",      blurb: "Responsive layout & touch" },
  CopyBrand:     { label: "Copy & Brand",   blurb: "Voice, claims, and consistency" },
  Performance:   { label: "Performance",    blurb: "Weight, scripts, and loading" },
};
