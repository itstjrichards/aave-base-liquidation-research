FROM node:22-slim

# ca-certificates: node:22-slim doesn't ship it, so curl can't verify any HTTPS connection
# without it (fails with "error setting certificate file: /etc/ssl/certs/ca-certificates.crt").
# python3/make/g++: needed to compile better-sqlite3's native binding for this image's own
# architecture (built on the target machine, per the deployment plan — no cross-compilation).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Foundry (anvil) is required for local forking — installed at build time so it's baked into
# the image rather than re-downloaded on every container start.
ENV FOUNDRY_DIR=/root/.foundry
ENV PATH="${FOUNDRY_DIR}/bin:${PATH}"
RUN curl -L https://foundry.paradigm.xyz | bash && foundryup

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Run the compiled JS directly (not tsx/npx at runtime) so node is PID 1 with no wrapper
# process in between — that's what lets docker's SIGTERM reach the app's own signal handler
# directly instead of being absorbed by an intermediate process.
CMD ["node", "dist/watchers/healthFactorWatcher.js"]
