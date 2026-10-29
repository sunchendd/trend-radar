# 两阶段：装依赖+构建 → 只带运行所需
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/web/package.json web/
RUN npm ci --omit=dev
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
VOLUME ["/app/data"]
ENV TREND_RADAR_DATA_DIR=/app/data PORT=8787 HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server/dist/index.js", "serve"]
