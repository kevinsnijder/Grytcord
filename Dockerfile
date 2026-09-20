FROM node:22-trixie

ENV PNPM_HOME="/pnpm"

ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm

WORKDIR /app

COPY package.json ./

COPY pnpm-workspace.yaml pnpm-lock.yaml* ./

RUN pnpm install

COPY . .

RUN sed -i 's/\r//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

EXPOSE 8080

# 200 only when Discord and at least one Gryt server are online, 503 otherwise
# (see utils/HealthCheck.js). Uses node -e + fetch so no curl is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["./docker-entrypoint.sh"]
