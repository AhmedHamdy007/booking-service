# Stage 1: Dependencies
FROM node:20.19-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: Production
FROM node:20.19-slim AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002

RUN addgroup --system appgroup && \
    adduser --system --ingroup appgroup appuser

COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY shared/http/ /shared/http/
COPY package.json ./

USER appuser

EXPOSE 3002

HEALTHCHECK --interval=30s \
            --timeout=5s \
            --start-period=15s \
            --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" || exit 1

CMD ["node", "src/index.js"]
