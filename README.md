# AI Studio Build App Reverse Proxy

这是一个为 Google AI Studio 的 "Build App" 功能设计的反向代理项目。它允许您通过 API 的方式，调用和使用在 AI Studio 中构建的应用模型。

本项目强制依赖于 [daijro/camoufox](https://github.com/daijro/camoufox) 项目提供的浏览器环境。

---

## 🚀 项目特点

本项目专注于 **Docker 容器化部署**，并在原项目的基础上，利用 AI 进行了深度定制和功能增强，旨在提供一个**更健壮、更稳定、更易于维护**的生产级解决方案。

> **免责声明**: 本仓库的所有代码修改均由 AI 生成，旨在探索自动化编程与应用优化的可能性。请在充分理解代码功能和潜在风险的基础上酌情使用，作者对可能产生的任何问题概不负责。

---

###  🚀Quick Start / 快速开始

要快速启动并运行此项目，请遵循以下步骤。

1.  📝 **准备 `docker-compose.yml` 文件**:
    在项目根目录创建 `docker-compose.yml`，并粘贴以下内容：
    ```yaml
    version: '3.8'

    services:
      build-server:
        image: ghcr.io/junwu-git/build-server:latest
        container_name: build-server
        restart: on-failure:5
        ports:
          - "8889:8889"
        env_file:
          - .env
        deploy:
          resources:
            limits:
              memory: 1024M          
        volumes:
          - ./auth:/home/user/auth
          - ./debug-screenshots:/home/user/debug-screenshots
    ```

2.  🔑 **准备 `.env` 文件**:
    在项目根目录创建 `.env` 文件，并粘贴以下内容。请**务必替换 `API_KEYS`** 为您的实际密钥。
    ```env
    # User and Group IDs for permission handling.
    # This is used by entrypoint.sh script to match your host user.
    # Find these using 'id -u' and 'id -g' on your host.
    TARGET_UID=YOUR_HOST_UID_HERE # 例如 1001
    TARGET_GID=YOUR_HOST_GID_HERE # 例如 1001

    # --- Your Secrets (Required) ---
    API_KEYS=your_secret_api_key_here

    # --- Optional Configurations ---
    FAILURE_THRESHOLD=0
    MAX_RETRIES=3
    RETRY_DELAY=3000
    IMMEDIATE_SWITCH_STATUS_CODES=429,503
    STREAMING_MODE=fake
    ```

3.  📁 **创建本地目录**:
    确保项目根目录下存在 `auth` 和 `debug-screenshots` 目录，并将您的 `auth-X.json` 文件放入 `auth` 目录。
    为了避免权限问题，建议手动创建 `debug-screenshots` 目录，并赋予其写入权限：
    ```bash
    mkdir auth debug-screenshots
    chmod 777 debug-screenshots # 确保所有用户可读写，避免权限问题
    ```

5.  🚀 **启动服务**:
    ```bash
    docker-compose up -d
    ```
