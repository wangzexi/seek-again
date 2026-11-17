FROM oven/bun:1.4.2 AS frontend
WORKDIR /build
COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
RUN bun install --frozen-lockfile
COPY web/ ./web/
COPY shared/ ./shared/
COPY LICENSE ./
RUN bun run build

FROM rust:1.95-bookworm AS backend
WORKDIR /build
COPY server/ ./server/
COPY shared/ ./shared/
RUN cargo build --release --locked --manifest-path server/Cargo.toml \
    && strip server/target/release/deepseek-chat-server

FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/wangzexi/seek-again"
WORKDIR /app
COPY --from=backend /build/server/target/release/deepseek-chat-server /app/seek-again
COPY --from=frontend /build/dist/ /app/dist/
ENV HOST=0.0.0.0 PORT=8090
EXPOSE 8090
ENTRYPOINT ["/app/seek-again"]
