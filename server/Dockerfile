# Server Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install deps first (better caching)
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install

# Copy source
COPY src ./src

# Build TypeScript -> dist
RUN npm run build

# Use Render's PORT env var (optional but nice)
ENV PORT=3000
EXPOSE 3000

# Run the compiled server (avoid npm start indirection)
CMD ["node", "dist/index.js"]
