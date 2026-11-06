# One container, nothing else to run: the server with its built-in SQLite, and the headless Chromium it
# draws canvas previews with. Data lives in /data.
FROM node:22-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The whole source first: the editor's packages are npm workspaces, which npm ci needs to see.
COPY . .
RUN npm ci \
  && npx playwright-core install --with-deps chromium-headless-shell \
  && npm run build \
  && npm prune --omit=dev \
  && rm -rf /root/.npm /root/.cache
ENV DATA_DIR=/data BIND=0.0.0.0 PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["npx", "tsx", "server/index.ts"]
