# --------------------------------------------------------------------
# 阶段 1: 使用 Playwright 官方镜像 v1.44.0 (基于 Ubuntu Jammy)
# 该镜像已包含所有系统依赖和浏览器，是最可靠的方案。
# --------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# 设置工作目录
WORKDIR /app

# 复制 package.json 并安装生产依赖
# 使用 npm ci 以确保使用 lock 文件进行确定性安装
COPY package*.json ./
RUN npm ci --omit=dev

# 复制所有应用代码
COPY . .

# 暴露应用端口
EXPOSE 8889

# 最终启动命令
CMD ["node", "unified-server.js"]