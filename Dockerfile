# Scriptorium's tools and npm dependencies. The code, stories and runs come
# from your checkout, mounted at /app by docker-compose.yml, so the image only
# needs rebuilding when package-lock.json changes.
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-trixie-slim

# ffmpeg/ffprobe: audio, music, video, reference images. ImageMagick 7: review
# contact sheets. fontconfig and a few fonts: system title fonts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg imagemagick git fontconfig fonts-dejavu-core fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Dependencies at /node_modules: Node finds them from /app, and they're built
# for this image, not the host (compose hides a checkout's own node_modules).
# onnxruntime (Kokoro's runtime) ships binaries for every OS and a 330 MB CUDA
# provider; the container uses only its own platform's CPU build.
COPY package.json package-lock.json /
RUN cd / && npm ci --omit=dev && npm cache clean --force \
 && arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && cd /node_modules/onnxruntime-node/bin/napi-v3 \
 && find . -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
 && find linux -mindepth 1 -maxdepth 1 ! -name "$arch" -exec rm -rf {} + \
 && rm -f linux/*/libonnxruntime_providers_cuda.so linux/*/libonnxruntime_providers_tensorrt.so

# Model and voice-library caches, kept in a volume between runs. Compose runs
# as the host's UID, whatever it is, so the cache is open to any user.
ENV XDG_CACHE_HOME=/cache
RUN mkdir -p /cache /app && chmod 1777 /cache && chown node:node /app
USER node
WORKDIR /app
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["doctor"]
