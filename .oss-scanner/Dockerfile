# Build image for Anthropic's OSS Scanner (github.com/anthropics/oss-scanner).
# The scan runs offline, so everything the CLI and its reproductions reach
# for is fetched here: dev dependencies and every registered core package.
FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive \
    HEDGEHOG_NO_UPDATE_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*

# Non-root, so the reproductions that rely on chmod-denied writes hold.
COPY --chown=node:node . /src
USER node
WORKDIR /src

# Reproductions commit into throwaway git repos and need an identity.
RUN git config --global user.name "oss-scanner" \
    && git config --global user.email "oss-scanner@localhost" \
    && git config --global init.defaultBranch master

RUN npm ci --ignore-scripts --no-audit --no-fund

# Warm ~/.hedgehog/cores so `init` and `core install` work without network.
RUN node --input-type=module -e "\
  import { loadRegistry } from './src/registry/index.mjs'; \
  import { fetchCore } from './src/registry/fetch.mjs'; \
  for (const entry of await loadRegistry()) { \
    try { await fetchCore(entry); console.log('cached', entry.name); } \
    catch (err) { console.log('WARNING: could not cache', entry.name, err.message); } \
  }"

# Smoke-test the image; failures are reported, not fatal.
RUN (npm run lint || echo "WARNING: lint reported failures") \
    && (npm run repro || echo "WARNING: reproductions reported failures")
