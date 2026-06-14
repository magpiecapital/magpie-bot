FROM node:26-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ ./src/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/

CMD ["node", "src/index.js"]
