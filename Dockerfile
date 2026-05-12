# Multi-stage Dockerfile for Launch QA Assistant.
# Base: official Playwright image — Chromium + system deps preinstalled.

ARG PLAYWRIGHT_VERSION=1.59.1

# ---- deps ----
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS deps
WORKDIR /app
COPY package*.json ./
# Browsers are already in the base image; skip the download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# ---- builder ----
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner ----
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy the built app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

EXPOSE 3000

# Healthcheck — let Docker / DO know when we're ready
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider http://localhost:3000/ || exit 1

CMD ["npm", "start"]
