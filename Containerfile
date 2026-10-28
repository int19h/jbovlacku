ARG RUST_IMAGE=docker.io/library/rust:1.99.0-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6
ARG NODE_IMAGE=docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${RUST_IMAGE} AS core
ENV CARGO_BUILD_JOBS=2
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-bindgen-cli --version 0.2.105 --locked --jobs 2
WORKDIR /source
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ crates/
COPY scripts/build-core.sh scripts/build-core.sh
RUN bash scripts/build-core.sh

FROM ${NODE_IMAGE} AS application
WORKDIR /source
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY docs/dependencies.md docs/third-party-notices.md docs/
COPY scripts/copy-notices.mjs scripts/copy-notices.mjs
COPY --from=core /source/packages/core/generated/ packages/core/generated/
RUN npm run build:server && npm run build:web

FROM ${NODE_IMAGE} AS standalone
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8789 \
    JVC_DATA_DIR=/var/lib/jbovlacku \
    JVC_ASSETS_DIR=/app/apps/web/dist
WORKDIR /app
RUN mkdir -p /var/lib/jbovlacku && chown node:node /var/lib/jbovlacku
COPY package.json ./
COPY docs/dependencies.md docs/third-party-notices.md docs/
COPY --from=core /source/packages/core/generated/rust-standard-library-notices.html docs/rust-standard-library-notices.html
COPY --from=application /source/apps/server/dist/notices/morphology-notices.md docs/morphology-notices.md
COPY --from=application --chown=node:node /source/apps/server/dist/ apps/server/dist/
COPY --from=application --chown=node:node /source/apps/web/dist/ apps/web/dist/
COPY --from=core --chown=node:node /source/packages/core/generated/ packages/core/generated/
USER node
VOLUME ["/var/lib/jbovlacku"]
EXPOSE 8789
STOPSIGNAL SIGTERM
CMD ["node", "apps/server/dist/main.js"]
