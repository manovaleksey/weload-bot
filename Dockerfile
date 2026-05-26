FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    unzip \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

RUN pip3 install --break-system-packages --upgrade yt-dlp

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

ARG CACHEBUST=1
COPY bot.js ./

RUN mkdir -p bin && \
    ln -sf $(which yt-dlp) bin/yt-dlp && \
    ln -sf $(which ffmpeg) bin/ffmpeg

RUN mkdir -p data

ENV DB_PATH=/app/data/weload.db
ENV BUILD_VER=1.1.0

CMD ["node", "bot.js"]
