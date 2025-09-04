FROM node:18-slim

# 安装必要的系统依赖，并新增 gosu 用于权限切换
RUN apt-get update && apt-get install -y \
    wget \
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
    gosu \
    && rm -rf /var/lib/apt/lists/*

# 创建一个默认的 user 用户 (UID/GID 在启动时会被 entrypoint 脚本修改)
RUN useradd -m -s /bin/bash user
WORKDIR /home/user

# 安装依赖
COPY package*.json ./
RUN npm install

# 复制应用文件，包括 entrypoint 脚本
COPY entrypoint.sh /usr/local/bin/
COPY unified-server.js dark-browser.js ./
COPY auth/ ./auth/
COPY camoufox-linux/ ./camoufox-linux/

# 仅设置可执行权限，所有权将在 entrypoint 脚本中动态修复
RUN chmod +x /usr/local/bin/entrypoint.sh && \
    chmod +x /home/user/camoufox-linux/camoufox

# 暴露端口作为镜像的元数据，这是一个最佳实践
EXPOSE 8889

# 设置 Entrypoint，容器启动时会首先执行这个脚本
ENTRYPOINT ["entrypoint.sh"]

# 定义默认命令，它会作为参数传递给 Entrypoint
CMD ["node", "unified-server.js"]