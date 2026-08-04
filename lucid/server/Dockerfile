# Node 22+ is required — the app uses the built-in `node:sqlite` module,
# which isn't available on older versions.
FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached unless package.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Then copy the rest of the app.
COPY src ./src
COPY public ./public

# Run as a non-root user rather than the container default root.
RUN useradd --create-home --shell /bin/bash lucid \
  && mkdir -p /data \
  && chown -R lucid:lucid /app /data
USER lucid

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/dev.db \
    UPLOADS_DIR=/data/uploads

EXPOSE 3000

# Basic container-level healthcheck hitting the app's own /api/health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
