FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxshmfence1 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libatspi2.0-0 \
    fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY turnstile-solver/requirements.txt /solver/requirements.txt
RUN pip3 install --no-cache-dir -r /solver/requirements.txt
RUN python3 -m patchright install chromium

COPY server.mjs config.json .env.example ./
COPY turnstile-solver /solver
COPY start-all.sh /app/start-all.sh
RUN mkdir -p /app/data

EXPOSE 8787

ENV ALMMA_TURNSTILE_SOLVER_BASE_URL=http://127.0.0.1:5000

CMD ["/app/start-all.sh"]
