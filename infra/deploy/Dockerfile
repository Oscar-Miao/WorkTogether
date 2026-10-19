FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /var/lib/team-agent && chown node:node /var/lib/team-agent
USER node
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3001 TEAM_AGENT_SERVER_DATA_DIR=/var/lib/team-agent
EXPOSE 3001
HEALTHCHECK --interval=20s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","apps/api/dist/main.js"]
