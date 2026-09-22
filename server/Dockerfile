FROM rust:1.82-slim
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release
EXPOSE 3000
CMD ["./target/release/livebr-server"]
