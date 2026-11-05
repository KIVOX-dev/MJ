# syntax=docker/dockerfile:1.7
# AppSail only runs OCI images built for linux/amd64, so build with:
#   docker build --platform linux/amd64 -f docker/Dockerfile -t mj:latest .
# (build context = repo root; ignore rules live in docker/Dockerfile.dockerignore)

# ---- build stage: install all deps and compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- production deps only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=9000
WORKDIR /app
# tini = proper PID 1 so SIGTERM reaches Node (graceful shutdown)
RUN apk add --no-cache tini fontconfig ttf-dejavu
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# fonts for the MJ Times PDF (Anek Tamil, SIL OFL 1.1)
COPY --chown=node:node assets ./assets
COPY --chown=node:node package.json ./
USER node
EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
