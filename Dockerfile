# 阶段 1: 构建器 (Builder)
# 这个阶段用于构建所有资源，包括下载依赖和编译代码。
FROM node:20 AS builder

# 设置工作目录
WORKDIR /app

# 安装构建时所需的系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends wget unzip ca-certificates

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装所有 npm 模块，包括 devDependencies
RUN npm install

# 下载并解压 Camoufox 浏览器
RUN wget https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip \
    && unzip -o camoufox-135.0.1-beta.24-lin.x86_64.zip -d camoufox-linux \
    && rm camoufox-135.0.1-beta.24-lin.x86_64.zip

# 复制项目的其余所有文件
COPY . .

# --------------------------------------------------------------------

# 阶段 2: 最终生产镜像 (Final Image)
# 这个阶段只包含运行应用所需的最小依赖和文件。
FROM node:20-slim

# 设置工作目录
WORKDIR /app

# 安装运行 Playwright 浏览器所需的系统依赖
# 使用 npx playwright install-deps 来自动安装，并清理 apt 缓存
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && npx playwright install-deps firefox \
    && rm -rf /var/lib/apt/lists/*

# 从 builder 阶段复制 package.json 和 package-lock.json
COPY --from=builder /app/package*.json ./

# 只安装生产环境所需的 npm 模块
RUN npm install --omit=dev

# 从 builder 阶段复制应用程序的源代码
COPY --from=builder /app/ .

# 从 builder 阶段复制已经解压好的 Camoufox 浏览器文件夹
COPY --from=builder /app/camoufox-linux /app/camoufox-linux

# 设置 Camoufox 的可执行路径环境变量
ENV CAMOUFOX_EXECUTABLE_PATH="/app/camoufox-linux/camoufox"

# 暴露应用端口
EXPOSE 8889

# 最终启动命令
CMD ["node", "unified-server.js"]