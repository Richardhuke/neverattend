# ---- 1. 构建前端（产物按 vite 配置落到 backend/static） ----
FROM node:22-alpine AS web
WORKDIR /app
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend ./frontend
COPY backend ./backend
RUN cd frontend && npm run build

# ---- 2. 运行时：只留后端依赖 + 静态产物 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend/src ./src
COPY backend/.env.example ./
COPY --from=web /app/backend/static ./static
ENV PORT=8000 STATIC_DIR=./static TYYS_MOCK=1 WATCH_INTERVAL_MS=10000
EXPOSE 8000
CMD ["node", "src/index.js"]
