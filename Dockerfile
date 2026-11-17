# syntax=docker/dockerfile:1
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /opt/conest
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts --no-audit --no-fund pnpm@11.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm check
# Keep the pinned M0 runtime packages, currently declared as development dependencies.
# A separate DSH installation matches the host layout used in the real Weixin test.

FROM base AS dsh
WORKDIR /opt/dsh
COPY containers/dsh/package.json containers/dsh/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN node -e 'try { require("node-addon-require-builtin").getBindingInfo() } catch (error) { console.dir(error, { depth: 8 }); process.exit(1) }'

FROM base AS runtime
ARG VERSION=development
ARG REVISION=unknown
LABEL org.opencontainers.image.title="CoNest" \
      org.opencontainers.image.source="https://github.com/cc8887/CoNest" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.licenses="MIT"
# Load the immutable native binaries directly; the private loader otherwise copies them into noexec /tmp.
ENV NODE_ENV=production CONEST_VERSION=$VERSION HOME=/data/home DSH_HOME=/data/dsh NARB_DISABLE_NATIVE_CACHE=1 CONEST_CONTAINER=1
WORKDIR /opt/conest
COPY --from=build /opt/conest/node_modules ./node_modules
COPY --from=build /opt/conest/lib ./lib
COPY --from=build /opt/conest/package.json /opt/conest/cordis.patch.yml /opt/conest/LICENSE /opt/conest/THIRD_PARTY_NOTICES.md ./
COPY --from=build /opt/conest/prompts ./prompts
COPY --from=build /opt/conest/skills ./skills
COPY --from=build /opt/conest/locale ./locale
COPY --from=build /opt/conest/examples/weixin.profile.cordis.patch.yml ./examples/weixin.profile.cordis.patch.yml
COPY --from=build /opt/conest/containers ./containers
COPY --from=dsh /opt/dsh /opt/dsh
RUN mkdir -p /data/home && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3087 3088 3089
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/conest/containers/entrypoint.mjs"]
CMD ["start"]
