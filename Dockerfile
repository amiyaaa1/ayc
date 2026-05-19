FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
COPY config.json ./

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["node", "server.mjs", "--config", "config.json", "--env-file", ".env"]
