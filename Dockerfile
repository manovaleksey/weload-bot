FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages yt-dlp

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js ./

RUN mkdir -p bin && \
    ln -sf $(which yt-dlp) bin/yt-dlp && \
    ln -sf $(which ffmpeg) bin/ffmpeg

CMD ["node", "bot.js"]
