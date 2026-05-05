import { NextRequest, NextResponse } from "next/server";
import { createJob, listJobs } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long-running endpoint: Lighthouse + crawl can take 30–60s.
export const maxDuration = 120;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let body: { url?: string; project?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON: { url, project? }" },
      { status: 400 },
    );
  }

  const raw = (body.url || "").trim();
  if (!raw) {
    return NextResponse.json({ error: "Missing 'url'" }, { status: 400 });
  }

  // Auto-prepend https:// if missing, so we can validate properly.
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (!isHttpUrl(candidate)) {
    return NextResponse.json(
      { error: "URL must be a valid http(s) URL" },
      { status: 400 },
    );
  }

  const job = createJob(candidate, body.project?.trim() || undefined);
  return NextResponse.json({ id: job.id, status: job.status }, { status: 202 });
}

export async function GET() {
  // Lightweight job list for debugging / admin.
  const jobs = listJobs().map(j => ({
    id: j.id,
    url: j.url,
    project: j.project,
    status: j.status,
    progress: j.progress,
    stage: j.stage,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    score: j.result?.score,
  }));
  return NextResponse.json({ jobs });
}
