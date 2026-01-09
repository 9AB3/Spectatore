# Server Dockerfile (Render-friendly)
FROM node:20-slim

WORKDIR /app

# 1) Copy only manifests first for better layer caching
COPY package.json package-lock.json tsconfig.json ./

# 2) Force public npm registry (prevents proxy/artifactory hijack)
# 3) Use npm ci for deterministic faster installs
RUN npm config set registry https://registry.npmjs.org/ \
 && npm ci --include=optional --no-audit --no-fund

# 4) Copy source
COPY src ./src

# 5) Build TypeScript -> dist
RUN npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
