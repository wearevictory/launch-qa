# Launch QA Assistant

Pre-launch QA reports for staging URLs. Drop in a staging link and get a structured audit covering SEO, accessibility, links, mobile, copy/brand, and performance — backed by Playwright, Lighthouse, axe-core, and a set of custom DOM checks.

## What it does

- **Real headless browser** — Playwright + Chromium loads the page (handles JS-rendered SPAs).
- **Lighthouse** — Performance, SEO, Accessibility, Best Practices scores.
- **axe-core** — WCAG 2.1 AA accessibility violations.
- **Custom DOM checks** — meta tags, heading order, viewport overflow, tap targets, lazy loading, render-blocking scripts, lorem ipsum, placeholder copy, CTA inconsistency, broken links.
- **Async job queue** — POST starts a scan and returns a job ID. The UI polls for progress.

A scan typically takes 25–60 seconds depending on page weight and link count.

## Local development

Requires Node.js 20+.

```bash
npm install
npx playwright install --with-deps chromium
npm run dev
```

Open http://localhost:3000.

> **Note:** Lighthouse needs Chrome/Chromium reachable on your machine. Local dev usually works because Playwright's chromium is on disk; on first scan, `chrome-launcher` will discover it. If Lighthouse fails locally with "Chrome not found", set `CHROME_PATH` to the chromium binary path.

## API

### POST `/api/scan`

```json
{ "url": "https://staging.example.com", "project": "Optional project name" }
```

Returns:

```json
{ "id": "lqv8m1ax-abc123", "status": "pending" }
```

### GET `/api/scan/:id`

Returns the full job, including `progress` (0–100), `stage` (e.g. "Running Lighthouse"), and once `status === "done"`, a `result` object with all findings and the launch readiness score.

### GET `/api/scan`

Returns the list of recent jobs (lightweight summary). Useful for debugging.

## Docker (one command)

```bash
docker build -t launch-qa .
docker run -p 3000:3000 --shm-size=1gb launch-qa
```

`--shm-size=1gb` is important. Chromium's default shared memory (64MB) will cause Lighthouse to crash on real-world pages.

Or with compose:

```bash
docker compose up --build -d
```

## Deploying to a Digital Ocean Droplet

The image is ~2GB (Playwright base ~1.5GB + Node deps). A **2 GB / 1 vCPU** Basic Droplet is the practical floor. **2 GB / 2 vCPU** is the comfortable starting point — Lighthouse uses CPU bursts.

### 1. Provision a Droplet

- Image: **Ubuntu 22.04 LTS**
- Plan: Basic / Regular SSD / **2 GB RAM / 2 vCPU** ($18/mo)
- Add your SSH key, give it a hostname.

### 2. SSH in and install Docker

```bash
ssh root@your-droplet-ip

apt update && apt install -y docker.io docker-compose-plugin git
systemctl enable --now docker
```

### 3. Pull this repo and build

```bash
git clone <your-repo-url> /opt/launch-qa
cd /opt/launch-qa
docker compose up --build -d
```

The first build takes 5–10 minutes (npm install + Next.js build inside Playwright base image). Subsequent builds are much faster thanks to layer caching.

### 4. Verify

```bash
curl -s http://localhost:3000/api/scan -X POST \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","project":"smoke test"}'
```

You should get back `{"id":"...","status":"pending"}`. Visit http://your-droplet-ip:3000 in a browser.

### 5. Put it behind Nginx + HTTPS (recommended)

```bash
apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/launch-qa`:

```nginx
server {
    server_name qa.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;   # scans can take a minute
        proxy_send_timeout 180s;
    }
}
```

Enable + TLS:

```bash
ln -s /etc/nginx/sites-available/launch-qa /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d qa.yourdomain.com
```

### 6. Lock it down (optional but recommended)

The MVP is open to anyone with the URL. Quick options before you share it widely:

- Add HTTP basic auth at the Nginx layer (`auth_basic`).
- Put it behind a Cloudflare Access policy.
- Add a shared `Authorization: Bearer …` check to `app/api/scan/route.ts`.

## Architecture notes

- **In-memory job store.** `lib/jobs.ts` keeps jobs in a `Map` on `globalThis`. Fine for single-instance MVP. If you scale to multiple containers, swap for Redis.
- **Sweeper** purges finished jobs older than 1 hour every 5 minutes.
- **Server externals.** `playwright`, `lighthouse`, `chrome-launcher`, and `@axe-core/playwright` are listed in `serverExternalPackages` so Next.js doesn't try to bundle their native deps.
- **Failure isolation.** Each check step is wrapped in `safeStep()` — one failed check won't kill the rest of the scan.

## Known limitations (v0.1)

- Only scans the URL you provide — no internal crawling.
- Link checking samples up to 30 unique links per scan.
- Requires the page to be reachable from the public internet (or from the Droplet, if you've allowlisted its IP).
- Scans run sequentially per process; concurrent requests will queue. Add a real queue (BullMQ/Redis) before you serve real traffic.
- Lighthouse runs in a separate Chrome instance — adds ~15s and ~500MB RAM. Disable by removing the call in `lib/scanner.ts` if you need to fit on a 1GB Droplet.

## File layout

```
app/
  layout.tsx          Root layout (fonts, metadata)
  page.tsx            Main UI — input form, polling, report
  globals.css         All styling (no Tailwind)
  api/scan/
    route.ts          POST (start) + GET (list)
    [id]/route.ts     GET single job
lib/
  types.ts            Finding, ScanResult, ScanJob
  score.ts            Severity weighting, score label
  markdown.ts         Markdown report export
  scanner.ts          The actual audit pipeline
  jobs.ts             In-memory job store + runner
Dockerfile            Multi-stage build on Playwright base
docker-compose.yml    Local + Droplet deploy convenience
```

## Roadmap

- Persistent storage (Postgres or SQLite) so scans survive restarts.
- Compare two scans (regression check before re-launching).
- Screenshot capture per breakpoint, attached to findings.
- Authenticated scans (cookies/headers/basic auth) for non-public staging sites.
- Internal crawling for multi-page audits.
- Real job queue (BullMQ) for concurrency.
