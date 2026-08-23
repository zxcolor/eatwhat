# Build context must be the repository root: docker build -f apps/api/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chi-shen-me/contracts build && pnpm --filter @chi-shen-me/api build
# pnpm 11's legacy deploy path is required until this workspace opts into
# injectWorkspacePackages. It creates an isolated production dependency graph
# and includes the built workspace contract package.
RUN pnpm --filter @chi-shen-me/api deploy --prod --legacy /prod/api

FROM node:24-alpine AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/api/package.json ./package.json
COPY --from=build --chown=node:node /prod/api/node_modules ./node_modules
COPY --from=build --chown=node:node /prod/api/dist ./dist
COPY --from=build --chown=node:node /workspace/apps/api/migrations ./migrations
USER node

# The administrator listener has its own Nest graph, process, database role and
# runtime Secret set. It is reachable only from the same-origin Next BFF network.
FROM runtime-base AS admin-runtime
EXPOSE 3002
CMD ["node", "dist/admin/admin-main.js"]

# The export worker has its own database role and RAM policy. It exposes no
# listener and must not receive API, auth-HMAC, OTP, OAuth or admin secrets.
FROM runtime-base AS export-worker-runtime
CMD ["node", "dist/data-export/export-worker-main.js"]

# Keep the ordinary user API as the default/final target. This process never
# imports AdminModule and deployment must not inject any ADMIN_* Secret.
FROM runtime-base AS runtime
EXPOSE 3001
CMD ["node", "dist/main.js"]
