# Server Dockerfile (Render bulletproof)
FROM node:20-slim

WORKDIR /app

# ---- Hard overrides (stop injected proxy/registry from hijacking npm) ----
ENV npm_config_registry=https://registry.npmjs.org/
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/

# Make npm fetches more resilient on CI/builders that occasionally drop connections
ENV npm_config_fetch_retries=5
ENV npm_config_fetch_retry_mintimeout=20000
ENV npm_config_fetch_retry_maxtimeout=120000

# If Render/builder injects proxies, blank them (common cause of "internal registry" fetches)
ENV HTTP_PROXY=
ENV HTTPS_PROXY=
ENV http_proxy=
ENV https_proxy=
ENV NO_PROXY=
ENV no_proxy=

# 1) Copy only manifests first for better layer caching
COPY package.json package-lock.json tsconfig.json ./

# 2) Install deps deterministically, forcing registry at command level
#    (command flag overrides most configs)
RUN node -p "process.version" \
 && echo "npm registry (env)=$npm_config_registry" \
 && npm config get registry \
 && echo "Sanitizing package-lock.json (in case an internal registry URL was injected)..." \
 && sed -i 's#https://packages\\.applied-caas-gateway1\\.internal\\.api\\.openai\\.org/artifactory/api/npm/npm-public/#https://registry.npmjs.org/#g' package-lock.json \
 && npm cache verify \
 && npm ci --registry=https://registry.npmjs.org/ --include=optional --no-audit --no-fund

# 3) Copy source + build helpers
COPY src ./src
COPY scripts ./scripts

# 4) Build TypeScript -> dist
RUN npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
