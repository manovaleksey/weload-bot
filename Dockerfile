FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY bot.js ./

# Create bin symlinks so the bot finds the binaries
RUN mkdir -p bin && \
    ln -sf /usr/local/bin/yt-dlp bin/yt-dlp && \
    ln -sf /usr/bin/ffmpeg bin/ffmpeg

CMD ["node", "bot.js"]
