# ── Stage 1: build & test ────────────────────────────────────────────────────
#
# node:20 (Debian) ships the build toolchain needed to compile native modules
# (better-sqlite3, bcrypt).  Using the same Debian base as node:20-slim means
# the compiled .node files are binary-compatible with the runtime stage.
FROM node:20 AS build

WORKDIR /build/server

# Install dependencies before copying source so this layer is cached as long
# as the lockfile is unchanged.
COPY server/package.json server/package-lock.json ./
RUN npm ci

# Copy server source then the client.  app.js resolves CLIENT_DIR as
# path.join(__dirname, '..', '..', 'client'), so the client must sit at
# the same level as the server directory.
COPY server/ ./
COPY client/ /build/client/

# Run both test suites.  Integration tests use an in-memory SQLite database
# and bind to an ephemeral port, so they need no external services.
RUN npm test
RUN npm run test:integration

# Strip dev-only packages; only the pruned node_modules move to the next stage.
RUN npm prune --omit=dev


# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

RUN groupadd --system app \
 && useradd  --system --gid app --no-create-home app

WORKDIR /app/server

# Production node_modules compiled in the build stage.
COPY --from=build /build/server/node_modules ./node_modules

# Application source.
COPY --from=build /build/server/src          ./src
COPY --from=build /build/server/games        ./games
COPY --from=build /build/server/scripts      ./scripts
COPY --from=build /build/server/package.json ./

# Static client files served by express.static inside app.js.
COPY --from=build /build/client /app/client

# data/ is the only directory the process writes to.  Mount a volume here in
# production so the SQLite database survives container restarts.
RUN mkdir -p data && chown app:app data

USER app

EXPOSE 3000

CMD ["node", "src/index.js"]
