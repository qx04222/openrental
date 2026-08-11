# Production image. Single Node process serving the API and the built client.
#
# Multi-stage so the runtime layer carries no build toolchain and no dev
# dependencies. Nothing here is cloud-vendor specific — this runs anywhere that
# can run a container and reach a Postgres.

FROM node:22-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Drop dev dependencies before copying node_modules into the runtime stage.
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Schema and seeds ship with the image so an operator can bootstrap a database
# from a running container rather than needing a checkout.
COPY --from=build /app/sql ./sql

USER node
EXPOSE 3000

# The app fails fast on an invalid APP_TIMEZONE or a missing DATABASE_URL, so a
# misconfigured container stops instead of serving wrong dates.
CMD ["node", "dist/index.js"]
