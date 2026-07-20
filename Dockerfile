FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @salesforce/cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY server ./server

# SF_AUTH_URL is set as a Render secret env var (from RENDER_AUTH_URL_PASTE_INTO_RENDER.txt),
# never committed. Auth import runs at container start, not build time.
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3001
CMD ["./docker-entrypoint.sh"]
