# --------------------------------------------------------------------
# 阶段 1: 仅作为 Playwright 官方浏览器的可靠来源
# 我们只使用这个阶段来获取预装好的浏览器文件。
# --------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS playwright_source

# --------------------------------------------------------------------
# 阶段 2: 构建最终的、经过优化的生产镜像
# 我们从一个轻量的 slim 镜像开始，以保证最终体积。
# --------------------------------------------------------------------
FROM node:18-bullseye-slim

# 安装运行 Playwright 浏览器所需的系统依赖。
# Playwright 提供了便捷的命令来自动安装所有必需的库。
# 我们只在安装时需要 wget，用完后即删除，以保持镜像干净。
RUN apt-get update && \
    apt-get install -y --no-install-recommends wget ca-certificates && \
    npx playwright install-deps firefox && \
    apt-get purge -y wget ca-certificates && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# 从第一阶段（playwright_source）精确地复制预装好的浏览器到我们的最终镜像中。
COPY --from=playwright_source /ms-playwright/firefox-* /ms-playwright/

# 设置环境变量，告诉 Playwright 在我们指定的新位置寻找浏览器。
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 设置工作目录
WORKDIR /app

# 复制 package.json 并安装生产依赖
COPY package*.json ./
RUN npm ci --omit=dev

# 复制所有应用代码
COPY . .

# 暴露应用端口
EXPOSE 8889

# 最终启动命令
CMD ["node", "unified-server.js"]