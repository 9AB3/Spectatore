# Server Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install
COPY src ./src
COPY .env.example ./.env
RUN npm run build
CMD ["npm","start"]