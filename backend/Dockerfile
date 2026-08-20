FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Cache and universe snapshots live here; mount a volume to survive rebuilds.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 3005
CMD ["node", "index.js"]
