# ---- Build Stage ----
FROM node:18-alpine AS build

# 切换到 root 以安装系统依赖
USER root

# 为 Playwright 安装 Alpine Linux 系统依赖
RUN apk add --no-cache \
    udev \
    ttf-freefont \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    xvfb \
    libxcomposite \
    libxcursor \
    libxdamage \
    libxext \
    libxfixes \
    libxi \
    libxrandr \
    libxrender \
    libxtst \
    cups-libs \
    dbus-libs \
    expat \
    pango \
    alsa-lib \
    at-spi2-atk \
    atk

# 设置工作目录并切换回非 root 用户
WORKDIR /home/node/app
USER node

# 复制 package.json 并安装依赖
COPY --chown=node:node package*.json ./
RUN npm ci

# 下载 Playwright 浏览器
RUN npx playwright install firefox

# 复制应用文件
COPY --chown=node:node . .

# ---- Production Stage ----
FROM node:18-slim

# 为 Playwright 安装必要的运行时依赖
# 这些是 --with-deps 无法自动安装的运行时依赖
RUN apt-get update && apt-get install -y \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*


# 设置工作目录
WORKDIR /home/node/app

# 从构建阶段复制生产依赖
COPY --from=build /home/node/app/node_modules ./node_modules

# 从构建阶段复制 Playwright 的浏览器缓存
COPY --from=build /home/node/.cache/ms-playwright/ /home/node/.cache/ms-playwright/

# 复制应用文件
COPY unified-server.js dark-browser.js ./
COPY auth/ ./auth/
COPY lib/ ./lib/
COPY dashboard/ ./dashboard/
COPY entrypoint.sh /usr/local/bin/

# 确保 Playwright 知道在哪里找到浏览器
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

# 切换到非 root 用户
USER node

# 修复文件所有权
RUN chown -R node:node /home/node/app && \
    chmod +x /usr/local/bin/entrypoint.sh

# 暴露端口
EXPOSE 8889

# 设置入口点
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# 默认命令
CMD ["node", "unified-server.js"]