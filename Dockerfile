# One image: web app (static), API + MCP (Node), and the STEP converter (Python + OpenCascade).
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY server ./server
COPY tools ./tools
RUN npx vite build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libgl1 libglib2.0-0 libxrender1 libxext6 libx11-6 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY tools/step2glb/requirements.txt tools/step2glb/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r tools/step2glb/requirements.txt
ENV PIMP_PYTHON=/opt/venv/bin/python DIST_DIR=/app/dist NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY tools ./tools
COPY --from=web /src/dist ./dist
EXPOSE 8080
CMD ["npx", "tsx", "server/api/index.ts"]
