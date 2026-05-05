/**
 * In-memory job store. Fine for an MVP single-instance deploy.
 * If you scale horizontally, swap this for Redis.
 *
 * The store survives Next.js dev hot-reloads via globalThis.
 */
import type { ScanJob, ScanResult } from "./types";
import { runScan } from "./scanner";

interface JobStore {
  jobs: Map<string, ScanJob>;
  // Sweep stale jobs every 5 min, keep last 1 hour.
  sweeperStarted?: boolean;
}

const g = globalThis as unknown as { __launchQaJobs?: JobStore };

function getStore(): JobStore {
  if (!g.__launchQaJobs) {
    g.__launchQaJobs = { jobs: new Map() };
  }
  const store = g.__launchQaJobs;
  if (!store.sweeperStarted) {
    store.sweeperStarted = true;
    setInterval(() => {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [id, job] of store.jobs) {
        const finished = job.finishedAt
          ? new Date(job.finishedAt).getTime()
          : null;
        if (finished && finished < cutoff) store.jobs.delete(id);
      }
    }, 5 * 60 * 1000);
  }
  return store;
}

function newId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

export function createJob(url: string, project?: string): ScanJob {
  const store = getStore();
  const id = newId();
  const job: ScanJob = {
    id,
    url,
    project,
    status: "pending",
    progress: 0,
    stage: "Queued",
    startedAt: new Date().toISOString(),
  };
  store.jobs.set(id, job);

  // Kick off the scan asynchronously.
  runJob(id).catch(err => {
    const j = store.jobs.get(id);
    if (j) {
      j.status = "error";
      j.error = err instanceof Error ? err.message : String(err);
      j.finishedAt = new Date().toISOString();
    }
  });

  return job;
}

export function getJob(id: string): ScanJob | undefined {
  return getStore().jobs.get(id);
}

export function listJobs(): ScanJob[] {
  return [...getStore().jobs.values()].sort(
    (a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

async function runJob(id: string): Promise<void> {
  const store = getStore();
  const job = store.jobs.get(id);
  if (!job) return;

  job.status = "running";
  job.stage = "Starting";

  try {
    const result: ScanResult = await runScan(job.url, (progress, stage) => {
      job.progress = progress;
      job.stage = stage;
    });
    job.result = result;
    job.status = "done";
    job.progress = 100;
    job.stage = "Done";
    job.finishedAt = new Date().toISOString();
  } catch (e: unknown) {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
    job.finishedAt = new Date().toISOString();
  }
}
