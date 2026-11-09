# One image, three start commands (Backend §15). The Playwright base carries Chromium for
# the browser-worker process; the api and ai-worker processes simply never launch it.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 vryse && useradd --system --uid 1001 --gid vryse vryse
COPY --from=build --chown=vryse:vryse /app/node_modules ./node_modules
COPY --from=build --chown=vryse:vryse /app/dist ./dist
COPY --from=build --chown=vryse:vryse /app/prisma ./prisma
COPY --chown=vryse:vryse package.json ./
USER vryse
EXPOSE 3000
# Overridden per deployable: npm run start | start:worker:browser | start:worker:ai
CMD ["node", "dist/http/server.js"]
