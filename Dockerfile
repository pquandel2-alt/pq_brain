# Brain — Container-Image. node:22-slim (better-sqlite3/sqlite-vec brauchen glibc,
# kein Alpine/musl). Daten + Modell-Cache liegen im Volume /app/data.
FROM node:22-slim

# Build-Tools nur für die native better-sqlite3-Kompilierung, danach entfernt.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Erst Manifeste → Layer-Caching für npm ci.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Alles unter /app/data (DB, Backups, Logs, Modell-Cache) → ein Volume.
ENV BRAIN_DATA_DIR=/app/data
ENV NODE_ENV=production
ENV PORT=3000
VOLUME ["/app/data"]
EXPOSE 3000

# HINWEIS: Beim allerersten Start lädt Brain das Embedding-Modell (bge-m3, ~mehrere
# hundert MB) in /app/data/models. Das kann 1–2 Minuten dauern; danach ist es im
# Volume gecacht. Der Healthcheck hat daher eine großzügige start-period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
