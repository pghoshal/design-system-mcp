# syntax=docker/dockerfile:1.7

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json biome.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ---- runtime stage ----
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app

COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --from=build --chown=nonroot:nonroot /app/package.json ./

ENV NODE_ENV=production
EXPOSE 3000
USER nonroot

ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]
