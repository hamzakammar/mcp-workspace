FROM node:20-alpine

# Install system dependencies for headless browser + VNC streaming
RUN apk add --no-cache \
    # Chromium
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ttf-opensans \
    libstdc++ \
    libgcc \
    # Virtual display
    xvfb \
    dbus \
    udev \
    # VNC server
    x11vnc \
    # Python for websockify
    python3 \
    py3-pip \
    py3-numpy \
    # noVNC dependencies
    bash \
    wget \
    git \
    # Process management
    supervisor

# Install websockify via pip
RUN pip3 install --break-system-packages websockify

# Install noVNC
RUN mkdir -p /usr/share/novnc && \
    wget -q https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz -O /tmp/novnc.tar.gz && \
    tar -xzf /tmp/novnc.tar.gz -C /tmp && \
    cp -r /tmp/noVNC-1.4.0/* /usr/share/novnc/ && \
    rm -rf /tmp/novnc.tar.gz /tmp/noVNC-1.4.0

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Install Playwright's Chromium (used by auth.ts headless token refresh)
RUN npx playwright install chromium --with-deps || true

# Prune dev dependencies after playwright install
RUN npm prune --production

# Copy built app
COPY dist ./dist
COPY scripts ./scripts

# Create sessions directory (will be overridden by EFS mount in ECS)
RUN mkdir -p /sessions

# Set environment variables
ENV SESSIONS_PATH=/sessions
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
# Point Playwright to system Chromium for VNC sessions (headed mode)
# For headless auth refreshes, Playwright uses its own installed binary
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3000
# VNC/websockify ports (6080+) bind to 127.0.0.1 and are reached only via the
# Express /vnc/<id>/websockify proxy, so they are intentionally not exposed.

CMD ["node", "dist/index.js"]
