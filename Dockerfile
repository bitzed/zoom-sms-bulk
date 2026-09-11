# node:sqlite needs Node >= 22.5, which every 22.x tag now satisfies.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY samples ./samples
COPY env.example README.md ./

# Run unprivileged, and make /data writable by that user. Without a volume
# mounted here the app refuses to start rather than losing drafts silently.
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data && chown -R app:app /data
USER app

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "src/cli.js"]
CMD ["serve"]
