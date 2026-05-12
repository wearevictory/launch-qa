/**
 * Launch QA scanner.
 *
 * Pipeline:
 *   1. Launch Playwright Chromium, load the URL.
 *   2. Run custom DOM checks (SEO, mobile, perf basics, copy/brand, links).
 *   3. Run axe-core via @axe-core/playwright.
 *   4. Run a separate headless Chrome via chrome-launcher and run Lighthouse.
 *   5. Aggregate everything into Finding[] and compute a score.
 *
 * Each step is wrapped in try/catch so a single failure doesn't kill the scan.
 */

import { chromium } from "playwright";
import type { Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import * as cheerio from "cheerio";
import type { Finding, ScanResult, Severity, Category } from "./types";
import { computeScore } from "./score";

type ProgressCallback = (progress: number, stage: string) => void;

const fid = () => Math.random().toString(36).slice(2, 9);

function mkFinding(
  category: Category,
  sev: Severity,
  title: string,
  detail: string,
  fix: string,
  source: string,
  evidence?: string,
): Finding {
  return { id: fid(), category, sev, title, detail, fix, source, evidence };
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/* -------------------------------------------------------------- */
/* Main entry point                                                */
/* -------------------------------------------------------------- */

export async function runScan(
  rawUrl: string,
  onProgress?: ProgressCallback,
): Promise<ScanResult> {
  const startedAt = Date.now();
  const url = normalizeUrl(rawUrl);
  const findings: Finding[] = [];
  let lighthouseScores: ScanResult["lighthouse"];
  let finalUrl = url;

  onProgress?.(5, "Launching headless browser");

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 LaunchQA/0.1",
    });
    const page = await ctx.newPage();

    onProgress?.(15, "Loading page");

    let loadWarning = "";
    try {
      const resp = await page.goto(url, {
        waitUntil: "networkidle",
        timeout: 30_000,
      });
      finalUrl = resp?.url() || url;
    } catch (e: unknown) {
      loadWarning = e instanceof Error ? e.message : String(e);
      try {
        const resp = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        finalUrl = resp?.url() || url;
      } catch (e2: unknown) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return failureResult(rawUrl, url, msg, Date.now() - startedAt);
      }
    }
    if (loadWarning) {
      findings.push(
        mkFinding(
          "Performance",
          "med",
          "Page didn't reach network idle within 30s",
          `Used domcontentloaded fallback. Heavy ongoing requests can hurt performance and analytics. Original timeout: ${loadWarning}`,
          "Investigate what's still loading after DOM ready — usually third-party scripts or polling.",
          "playwright",
        ),
      );
    }

    onProgress?.(30, "Running SEO + heading checks");
    findings.push(...(await safeStep(() => seoChecks(page))));

    onProgress?.(40, "Running mobile checks");
    findings.push(...(await safeStep(() => mobileChecks(page))));

    onProgress?.(50, "Running performance checks");
    findings.push(...(await safeStep(() => perfChecks(page))));

    onProgress?.(60, "Running copy & brand checks");
    findings.push(...(await safeStep(() => copyChecks(page))));

    onProgress?.(70, "Crawling links");
    findings.push(...(await safeStep(() => linkChecks(page))));

    onProgress?.(80, "Running accessibility scan");
    findings.push(...(await safeStep(() => axeChecks(page))));
  } finally {
    await browser.close().catch(() => undefined);
  }

  onProgress?.(90, "Running Lighthouse");
  try {
    const lh = await runLighthouse(finalUrl);
    if (lh) {
      lighthouseScores = lh.scores;
      findings.push(...lh.findings);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    findings.push(
      mkFinding(
        "Performance",
        "low",
        "Lighthouse audit could not run",
        `${msg}. Other checks completed normally — score reflects custom + axe findings only.`,
        "Verify Chromium is installed and CHROME_PATH is set in the deploy env.",
        "lighthouse",
      ),
    );
  }

  const score = computeScore(findings);
  onProgress?.(100, "Done");

  return {
    url: rawUrl,
    finalUrl,
    scannedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    score,
    findings,
    lighthouse: lighthouseScores,
  };
}

async function safeStep(fn: () => Promise<Finding[]>): Promise<Finding[]> {
  try {
    return await fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      mkFinding(
        "Performance",
        "low",
        "A check step errored",
        `One of the audit steps failed: ${msg}. Other checks still ran.`,
        "Re-run the scan; if it persists, check server logs.",
        "scanner",
      ),
    ];
  }
}

function failureResult(
  rawUrl: string,
  url: string,
  message: string,
  durationMs: number,
): ScanResult {
  return {
    url: rawUrl,
    finalUrl: url,
    scannedAt: new Date().toISOString(),
    durationMs,
    score: 25,
    findings: [
      mkFinding(
        "Performance",
        "high",
        "Page failed to load",
        message,
        "Verify the URL is reachable from the public internet and returns a 2xx response. Check DNS, firewall, and that any auth/IP allowlists permit our scanner.",
        "playwright",
      ),
    ],
  };
}

/* -------------------------------------------------------------- */
/* SEO + heading checks                                            */
/* -------------------------------------------------------------- */

async function seoChecks(page: Page): Promise<Finding[]> {
  const out: Finding[] = [];
  const data = await page.evaluate(() => {
    const get = (sel: string) => document.querySelector(sel);
    const meta = (n: string) =>
      (document.querySelector(`meta[name="${n}"]`) as HTMLMetaElement | null)
        ?.content;
 // OpenGraph: spec says property="og:..." but plenty of CMSes (Yoast, etc.)
    // emit name="og:..." instead. Accept either.
    const ogMeta = (p: string) =>
      (document.querySelector(`meta[property="${p}"]`) as HTMLMetaElement | null)
        ?.content
      ?? (document.querySelector(`meta[name="${p}"]`) as HTMLMetaElement | null)
        ?.content;
    return {
      title: document.title,
      description: meta("description"),
      canonical: (get('link[rel="canonical"]') as HTMLLinkElement | null)?.href,
      ogTitle: ogMeta("og:title"),
      ogDescription: ogMeta("og:description"),
      ogImage: ogMeta("og:image"),
      ogUrl: ogMeta("og:url"),
      twitterCard: meta("twitter:card"),
      h1Count: document.querySelectorAll("h1").length,
      headingSequence: Array.from(
        document.querySelectorAll("h1,h2,h3,h4,h5,h6"),
      ).map(h => parseInt(h.tagName.slice(1), 10)),
      robotsMeta: meta("robots"),
      lang: document.documentElement.lang,
    };
  });

  if (!data.title || data.title.trim().length === 0) {
    out.push(
      mkFinding(
        "SEO",
        "high",
        "Missing <title>",
        "The page has no title tag — search results will fall back to the URL.",
        "Add a descriptive <title> of about 50–60 characters, leading with the primary keyword.",
        "seo",
      ),
    );
  } else if (data.title.length > 70) {
    out.push(
      mkFinding(
        "SEO",
        "med",
        `Title tag is ${data.title.length} characters`,
        `The <title> will be truncated in search results. Title: "${data.title}"`,
        "Trim to ~55 characters, leading with the primary keyword and brand.",
        "seo",
      ),
    );
  }

  if (!data.description) {
    out.push(
      mkFinding(
        "SEO",
        "high",
        "Missing meta description",
        'No <meta name="description"> tag. Search engines will auto-generate snippets, often poorly.',
        "Add a 150–160 character meta description summarizing the page's value proposition.",
        "seo",
      ),
    );
  } else if (data.description.length < 50) {
    out.push(
      mkFinding(
        "SEO",
        "low",
        "Meta description is short",
        `Only ${data.description.length} characters. Aim for 150–160 to maximize SERP real estate.`,
        "Expand the description to 150–160 characters.",
        "seo",
      ),
    );
  }

  if (!data.canonical) {
    out.push(
      mkFinding(
        "SEO",
        "med",
        "No canonical URL set",
        "Without a canonical, query parameters and trailing slashes can fragment ranking signals.",
        'Add <link rel="canonical" href="..."> in the document head.',
        "seo",
      ),
    );
  }

  const missingOg: string[] = [];
  if (!data.ogTitle) missingOg.push("og:title");
  if (!data.ogDescription) missingOg.push("og:description");
  if (!data.ogImage) missingOg.push("og:image");
  if (!data.ogUrl) missingOg.push("og:url");
  if (missingOg.length) {
    out.push(
      mkFinding(
        "SEO",
        missingOg.length >= 3 ? "high" : "med",
        "Open Graph tags incomplete",
        `Missing: ${missingOg.join(", ")}. Social shares will fall back to default browser previews.`,
        "Add og:title, og:description, og:image (1200×630), og:url, plus twitter:card.",
        "seo",
      ),
    );
  }

  if (data.h1Count === 0) {
    out.push(
      mkFinding(
        "SEO",
        "med",
        "No <h1> on page",
        "Pages should have one canonical H1 describing the primary topic.",
        "Add a single <h1> describing the page.",
        "seo",
      ),
    );
  } else if (data.h1Count > 1) {
    out.push(
      mkFinding(
        "SEO",
        "low",
        `${data.h1Count} <h1> elements detected`,
        "Best practice is one H1 per page.",
        "Demote secondary H1s to H2 and keep one canonical H1.",
        "seo",
      ),
    );
  }

  // Heading sequence (no skipping levels)
  const seq = data.headingSequence;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] - seq[i - 1] > 1) {
      out.push(
        mkFinding(
          "Accessibility",
          "med",
          "Heading order skips levels",
          `Page jumps from H${seq[i - 1]} to H${seq[i]}.`,
          "Use sequential heading levels (H1 → H2 → H3) regardless of visual size.",
          "seo",
        ),
      );
      break;
    }
  }

  if (!data.lang) {
    out.push(
      mkFinding(
        "Accessibility",
        "med",
        "Missing <html lang> attribute",
        "Screen readers and translation tools rely on the lang attribute to pronounce content.",
        'Add lang="en" (or appropriate language) to the <html> element.',
        "seo",
      ),
    );
  }

  if (data.robotsMeta && /noindex/i.test(data.robotsMeta)) {
    out.push(
      mkFinding(
        "SEO",
        "high",
        "Page is set to noindex",
        `<meta name="robots" content="${data.robotsMeta}"> will block search engine indexing.`,
        "Remove noindex when ready to launch.",
        "seo",
      ),
    );
  }

  return out;
}

/* -------------------------------------------------------------- */
/* Mobile checks                                                   */
/* -------------------------------------------------------------- */

async function mobileChecks(page: Page): Promise<Finding[]> {
  const out: Finding[] = [];

  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(500);

  const data = await page.evaluate(() => {
    const docW = document.documentElement.scrollWidth;
    const winW = window.innerWidth;
    const overflow = docW - winW;

    const interactive = document.querySelectorAll(
      "a, button, input[type=button], input[type=submit]",
    );
    const smallTargets: { tag: string; w: number; h: number }[] = [];
    interactive.forEach(el => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        (rect.width < 44 || rect.height < 44)
      ) {
        smallTargets.push({
          tag: el.tagName.toLowerCase(),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }
    });

    const viewport = (
      document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null
    )?.content;

    return {
      overflow,
      viewport,
      smallTargetSamples: smallTargets.slice(0, 5),
      smallTargetCount: smallTargets.length,
    };
  });

  if (data.overflow > 4) {
    out.push(
      mkFinding(
        "Mobile",
        "high",
        "Horizontal overflow at 375px",
        `Document is ${data.overflow}px wider than the viewport — causes horizontal scrolling on phones.`,
        "Set max-width:100% on media; check for uncontained <pre>, tables, or fixed-width grids.",
        "mobile",
      ),
    );
  }

  if (!data.viewport) {
    out.push(
      mkFinding(
        "Mobile",
        "high",
        "Missing viewport meta tag",
        'No <meta name="viewport"> — mobile browsers will render at desktop width and zoom out.',
        'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
        "mobile",
      ),
    );
  } else if (!/width=device-width/i.test(data.viewport)) {
    out.push(
      mkFinding(
        "Mobile",
        "med",
        "Viewport meta missing width=device-width",
        `Current: ${data.viewport}`,
        'Use <meta name="viewport" content="width=device-width, initial-scale=1">.',
        "mobile",
      ),
    );
  }

  if (data.smallTargetCount > 0) {
    out.push(
      mkFinding(
        "Mobile",
        data.smallTargetCount > 5 ? "med" : "low",
        `${data.smallTargetCount} tap targets below 44×44px`,
        `Sample: ${data.smallTargetSamples.map(t => `<${t.tag}> ${t.w}×${t.h}`).join(", ")}. iOS HIG and WCAG 2.5.5 recommend 44×44 minimum.`,
        "Increase tap target size via padding (not larger icons) to 44×44 minimum.",
        "mobile",
      ),
    );
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  return out;
}

/* -------------------------------------------------------------- */
/* Performance basics (DOM-level)                                  */
/* -------------------------------------------------------------- */

async function perfChecks(page: Page): Promise<Finding[]> {
  const out: Finding[] = [];

  const data = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll("img"));
    let nonLazy = 0;
    let noDimensions = 0;
    imgs.forEach((img, i) => {
      const lazy = (img as HTMLImageElement).loading === "lazy";
      const hasDims = img.hasAttribute("width") && img.hasAttribute("height");
      if (i > 1 && !lazy) nonLazy++;
      if (!hasDims) noDimensions++;
    });

    const scripts = document.querySelectorAll("script[src]");
    const headScripts = Array.from(
      document.querySelectorAll("head script[src]"),
    );
    const blockingScripts = headScripts.filter(s => {
      const el = s as HTMLScriptElement;
      return !el.async && !el.defer;
    });

    return {
      imgCount: imgs.length,
      nonLazy,
      noDimensions,
      blockingScriptCount: blockingScripts.length,
      blockingScriptSamples: blockingScripts
        .slice(0, 3)
        .map(s => (s as HTMLScriptElement).src),
      totalScripts: scripts.length,
    };
  });

  if (data.imgCount > 5 && data.nonLazy >= data.imgCount - 2) {
    out.push(
      mkFinding(
        "Performance",
        "med",
        "Below-the-fold images not lazy-loaded",
        `${data.nonLazy} of ${data.imgCount} images render eagerly.`,
        'Add loading="lazy" to all below-the-fold <img> tags.',
        "perf",
      ),
    );
  }

  if (data.noDimensions > 3) {
    out.push(
      mkFinding(
        "Performance",
        "low",
        `${data.noDimensions} images missing width/height`,
        "Missing intrinsic dimensions causes Cumulative Layout Shift (CLS) as images load.",
        "Set explicit width and height attributes on all <img> tags.",
        "perf",
      ),
    );
  }

  if (data.blockingScriptCount > 2) {
    out.push(
      mkFinding(
        "Performance",
        "med",
        `${data.blockingScriptCount} render-blocking scripts in <head>`,
        `Sample: ${data.blockingScriptSamples.join(", ")}. Blocking scripts delay first paint.`,
        "Add defer or async, or move non-critical scripts before </body>.",
        "perf",
      ),
    );
  }

  if (data.totalScripts > 15) {
    out.push(
      mkFinding(
        "Performance",
        "low",
        `${data.totalScripts} script tags total`,
        "Many third-party scripts can degrade Core Web Vitals.",
        "Audit and consolidate via tag manager; remove unused tracking.",
        "perf",
      ),
    );
  }

  return out;
}

/* -------------------------------------------------------------- */
/* Copy / brand checks                                             */
/* -------------------------------------------------------------- */

async function copyChecks(page: Page): Promise<Finding[]> {
  const out: Finding[] = [];
  const html = await page.content();
  const text = await page.evaluate(() => document.body?.innerText || "");

  if (
    /\blorem\s+ipsum\b/i.test(text) ||
    /\bdolor\s+sit\s+amet\b/i.test(text)
  ) {
    out.push(
      mkFinding(
        "CopyBrand",
        "high",
        "Lorem ipsum detected",
        "Placeholder Latin text is still on the page.",
        "Replace with final approved copy from the client.",
        "copy",
      ),
    );
  }

  const placeholders: { re: RegExp; label: string }[] = [
    { re: /your\s+(text|copy|content|tagline)\s+here/i, label: "your X here" },
    { re: /client\s+logo\s+here/i, label: "client logo here" },
    { re: /\bplaceholder\b/i, label: "placeholder" },
    { re: /\bTBD\b/, label: "TBD" },
    { re: /\bTODO\b/, label: "TODO" },
    { re: /\bFIXME\b/, label: "FIXME" },
    { re: /coming\s+soon/i, label: "coming soon" },
  ];
  const hits = placeholders.filter(p => p.re.test(text)).map(p => p.label);
  if (hits.length > 0) {
    out.push(
      mkFinding(
        "CopyBrand",
        "high",
        "Placeholder copy detected",
        `Found: ${hits.join(", ")}.`,
        "Replace with final copy before launch.",
        "copy",
      ),
    );
  }

  if (
    /(hello|info|contact|hi)@(yourdomain|example|test|placeholder)\.com/i.test(
      html,
    )
  ) {
    out.push(
      mkFinding(
        "CopyBrand",
        "high",
        "Placeholder email detected",
        'A mailto link or text contains a template default like hello@yourdomain.com.',
        "Replace with the live agency or client email.",
        "copy",
      ),
    );
  }

  // CTA inconsistency
  const $ = cheerio.load(html);
  const ctaTexts: string[] = [];
  $("a, button").each((_idx, el) => {
    const t = $(el).text().trim();
    if (
      t &&
      t.length < 30 &&
      /(contact|talk|touch|start|hire|work|begin|reach|book|schedule)/i.test(t)
    ) {
      ctaTexts.push(t.toLowerCase());
    }
  });
  const uniqueCtas = new Set(ctaTexts);
  if (uniqueCtas.size >= 4) {
    out.push(
      mkFinding(
        "CopyBrand",
        "med",
        "Inconsistent CTA wording",
        `Found ${uniqueCtas.size} variations: ${[...uniqueCtas].slice(0, 5).join(", ")}.`,
        "Pick one canonical CTA label and apply globally.",
        "copy",
      ),
    );
  }

  // Mixed quote styles
  const straight = (text.match(/"/g) || []).length;
  const curly = (text.match(/[“”]/g) || []).length;
  if (straight > 5 && curly > 5) {
    out.push(
      mkFinding(
        "CopyBrand",
        "low",
        "Mixed quotation styles",
        `${straight} straight quotes and ${curly} curly quotes coexist.`,
        "Normalize to typographic curly quotes throughout body copy.",
        "copy",
      ),
    );
  }

  return out;
}

/* -------------------------------------------------------------- */
/* Link checks                                                     */
/* -------------------------------------------------------------- */

async function linkChecks(page: Page): Promise<Finding[]> {
  const out: Finding[] = [];

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a")).map(a => {
      const el = a as HTMLAnchorElement;
      return {
        href: el.href,
        text: el.textContent?.trim() || "",
        target: el.target,
        rel: el.rel,
      };
    }),
  );

  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).map(b => ({
      text: b.textContent?.trim() || "",
      ariaLabel: b.getAttribute("aria-label") || "",
    })),
  );

  const emptyButtons = buttons.filter(
    b => !b.text && !b.ariaLabel,
  ).length;
  if (emptyButtons > 0) {
    out.push(
      mkFinding(
        "Links",
        "high",
        `${emptyButtons} empty button${emptyButtons === 1 ? "" : "s"}`,
        "Buttons render with no visible text or aria-label.",
        "Add visible text or aria-label describing the action.",
        "links",
      ),
    );
  }

  let extMissingRel = 0;
  for (const l of links) {
    if (l.target === "_blank" && !/(noopener|noreferrer)/.test(l.rel))
      extMissingRel++;
  }
  if (extMissingRel > 0) {
    out.push(
      mkFinding(
        "Links",
        "low",
        `${extMissingRel} external links missing rel="noopener"`,
        'target="_blank" without rel="noopener noreferrer" is a small security risk.',
        'Add rel="noopener noreferrer" to all target="_blank" links.',
        "links",
      ),
    );
  }

  for (const l of links) {
    if (/^mailto:.+@(yourdomain|example|placeholder)\.com/i.test(l.href)) {
      out.push(
        mkFinding(
          "Links",
          "high",
          "Placeholder mailto link",
          `href="${l.href}" still uses a template default.`,
          "Replace with the live email address.",
          "links",
        ),
      );
      break;
    }
  }

// Sample-check up to 30 unique http(s) links for status.
  // Send realistic browser headers — without them, sites with bot protection
  // (Cloudflare, Akamai, big publishers) return 403 to anything that looks
  // automated. 401/403/429 are treated as "couldn't verify" rather than broken.
  const BROWSER_HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const BOT_BLOCK_STATUSES = new Set([401, 403, 429]);

  const uniqueHrefs = [
    ...new Set(
      links.map(l => l.href).filter(h => /^https?:\/\//i.test(h)),
    ),
  ].slice(0, 30);

  const broken: { href: string; status: number | string }[] = [];
  await Promise.all(
    uniqueHrefs.map(async href => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        let resp = await fetch(href, {
          method: "HEAD",
          redirect: "follow",
          signal: ctrl.signal,
          headers: BROWSER_HEADERS,
        });
        clearTimeout(t);
        // 405 = method not allowed; many servers reject HEAD even when GET works.
        // For other 4xx/5xx, retry with GET to confirm.
        if (!resp.ok && resp.status !== 405) {
          const ctrl2 = new AbortController();
          const t2 = setTimeout(() => ctrl2.abort(), 8000);
          resp = await fetch(href, {
            method: "GET",
            redirect: "follow",
            signal: ctrl2.signal,
            headers: BROWSER_HEADERS,
          });
          clearTimeout(t2);
        }
        // Skip statuses that almost certainly mean bot-blocking, not actual brokenness.
        if (!resp.ok && !BOT_BLOCK_STATUSES.has(resp.status)) {
          broken.push({ href, status: resp.status });
        }
      } catch (e: unknown) {
        const name = (e as { name?: string })?.name;
        broken.push({ href, status: name === "AbortError" ? "timeout" : "error" });
      }
    }),
  );

  if (broken.length > 0) {
    const sample = broken
      .slice(0, 3)
      .map(b => `${b.href} (${b.status})`)
      .join(", ");
    out.push(
      mkFinding(
        "Links",
        broken.length > 2 ? "high" : "med",
        `${broken.length} broken or unreachable link${broken.length === 1 ? "" : "s"}`,
        `Sample: ${sample}`,
        "Update or remove broken hrefs; consider 301 redirects for moved pages.",
        "links",
      ),
    );
  }

  return out;
}

/* -------------------------------------------------------------- */
/* axe-core                                                        */
/* -------------------------------------------------------------- */

async function axeChecks(page: Page): Promise<Finding[]> {
  const out: Finding[] = [];
  try {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();

    for (const v of results.violations) {
      const sev: Severity =
        v.impact === "critical" || v.impact === "serious"
          ? "high"
          : v.impact === "moderate"
            ? "med"
            : "low";
      out.push({
        id: fid(),
        category: "Accessibility",
        sev,
        title: v.help,
        detail: `${v.description} (${v.nodes.length} instance${v.nodes.length === 1 ? "" : "s"})`,
        fix: v.helpUrl
          ? `See axe rule "${v.id}": ${v.helpUrl}`
          : `Apply fix per axe rule "${v.id}".`,
        source: "axe-core",
        evidence: v.nodes[0]?.target?.join(" ") || undefined,
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    out.push(
      mkFinding(
        "Accessibility",
        "low",
        "axe-core could not run",
        `Error: ${msg}. Other accessibility checks still ran.`,
        "Check axe-core compatibility with the deployed Playwright version.",
        "axe",
      ),
    );
  }
  return out;
}

/* -------------------------------------------------------------- */
/* Lighthouse                                                      */
/* -------------------------------------------------------------- */

async function runLighthouse(
  url: string,
): Promise<{ scores: ScanResult["lighthouse"]; findings: Finding[] } | null> {
  // Dynamic imports — these are heavy and we don't want them bundled.
  const lighthouseMod: any = await import("lighthouse");
  const lighthouse = lighthouseMod.default || lighthouseMod;
  const chromeLauncher: any = await import("chrome-launcher");
  const playwrightChromium: any = (await import("playwright")).chromium;

  const chromePath =
    process.env.CHROME_PATH ||
    (typeof playwrightChromium.executablePath === "function"
      ? playwrightChromium.executablePath()
      : undefined);

  const chrome = await chromeLauncher.launch({
    chromePath,
    chromeFlags: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance", "seo", "accessibility", "best-practices"],
    });
    if (!result?.lhr) return null;
    const lhr = result.lhr;

    const round = (s: number | null | undefined) =>
      s == null ? null : Math.round(s * 100);

    const scores = {
      performance: round(lhr.categories.performance?.score),
      seo: round(lhr.categories.seo?.score),
      accessibility: round(lhr.categories.accessibility?.score),
      bestPractices: round(lhr.categories["best-practices"]?.score),
    };

    const findings: Finding[] = [];

    if (scores.performance != null && scores.performance < 50) {
      findings.push(
        mkFinding(
          "Performance",
          "high",
          `Lighthouse Performance: ${scores.performance}/100`,
          "Below 50 indicates significant performance issues affecting Core Web Vitals.",
          "Review Lighthouse opportunities — typically image optimization, JS minification, and reducing render-blocking resources.",
          "lighthouse",
        ),
      );
    } else if (scores.performance != null && scores.performance < 75) {
      findings.push(
        mkFinding(
          "Performance",
          "med",
          `Lighthouse Performance: ${scores.performance}/100`,
          "Room to improve. Aim for 90+ on production.",
          "Address top opportunities in the Lighthouse report.",
          "lighthouse",
        ),
      );
    }
    if (scores.seo != null && scores.seo < 90) {
      findings.push(
        mkFinding(
          "SEO",
          scores.seo < 70 ? "high" : "med",
          `Lighthouse SEO: ${scores.seo}/100`,
          "Lighthouse flagged SEO best-practice issues.",
          "Review SEO audits in the Lighthouse report.",
          "lighthouse",
        ),
      );
    }
    if (scores.accessibility != null && scores.accessibility < 90) {
      findings.push(
        mkFinding(
          "Accessibility",
          scores.accessibility < 70 ? "high" : "med",
          `Lighthouse Accessibility: ${scores.accessibility}/100`,
          "Lighthouse flagged accessibility issues beyond what axe-core caught.",
          "Review accessibility audits in the Lighthouse report.",
          "lighthouse",
        ),
      );
    }

    // Highlight specific high-impact opportunities
    const audits: Record<string, any> = lhr.audits || {};
    const opportunities: { id: string; cat: Category; sev: Severity; title: string }[] = [
      { id: "render-blocking-resources", cat: "Performance", sev: "med", title: "Eliminate render-blocking resources" },
      { id: "unused-javascript",         cat: "Performance", sev: "low", title: "Reduce unused JavaScript" },
      { id: "uses-optimized-images",     cat: "Performance", sev: "med", title: "Serve images in next-gen formats" },
      { id: "uses-text-compression",     cat: "Performance", sev: "med", title: "Enable text compression" },
      { id: "largest-contentful-paint",  cat: "Performance", sev: "high", title: "Largest Contentful Paint is slow" },
      { id: "cumulative-layout-shift",   cat: "Performance", sev: "med", title: "High Cumulative Layout Shift" },
    ];
    for (const op of opportunities) {
      const a = audits[op.id];
      if (!a) continue;
      const score = typeof a.score === "number" ? a.score : 1;
      if (score < 0.5 && a.title) {
        const cleanFix = a.description
          ? String(a.description).replace(/\[.*?\]\(.*?\)/g, "").trim()
          : "Review Lighthouse audit details.";
        findings.push({
          id: fid(),
          category: op.cat,
          sev: op.sev,
          title: op.title,
          detail: `${a.title}${a.displayValue ? ` — ${a.displayValue}` : ""}`,
          fix: cleanFix.slice(0, 300),
          source: "lighthouse",
        });
      }
    }

    return { scores, findings };
  } finally {
    await chrome.kill().catch(() => undefined);
  }
}
