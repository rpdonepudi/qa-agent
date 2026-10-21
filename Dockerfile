# Playwright's image ships Chromium and its system libraries; the tag must match @playwright/test in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# Run history (reports, specs, screenshots) lives here; mount a volume to keep it across deploys.
VOLUME /app/runs
CMD ["node", "dist/server.js"]
