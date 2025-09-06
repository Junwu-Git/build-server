# --------------------------------------------------------------------
# 构建最终的、经过优化的生产镜像
# 我们从一个轻量的 slim 镜像开始，以保证最终体积。
# --------------------------------------------------------------------
FROM node:18-bullseye-slim

# 设置工作目录
WORKDIR /app

# 安装运行 Playwright 浏览器和 Camoufox 所需的系统依赖。
# Playwright 提供了便捷的命令来自动安装所有必需的库。
# 我们只在安装时需要 wget 和 unzip，用完后即删除，以保持镜像干净。
RUN apt-get update && \
    apt-get install -y --no-install-recommends wget ca-certificates unzip && \
    npx playwright install-deps firefox && \
    apt-get purge -y wget ca-certificates unzip && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# 安装 wget 和 unzip，并清理 apt 缓存
RUN apt-get update && apt-get install -y wget unzip \
    && rm -rf /var/lib/apt/lists/*

# 下载并安装 Camoufox (使用用户验证过的方法)
RUN wget https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip \
    && unzip -o camoufox-135.0.1-beta.24-lin.x86_64.zip -d camoufox-linux \
    && rm camoufox-135.0.1-beta.24-lin.x86_64.zip

# 复制 package.json 并安装生产依赖
COPY package*.json ./
RUN npm ci --omit=dev

# 复制所有应用代码
COPY . .

# 设置 Camoufox 的可执行路径环境变量
ENV CAMOUFOX_EXECUTABLE_PATH="/app/camoufox-linux/firefox/firefox"

# 暴露应用端口
EXPOSE 8889

# 最终启动命令
CMD ["node", "unified-server.js"]