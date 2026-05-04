FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node . .

USER node

EXPOSE 4003
CMD ["node", "src/index.js"]
