# AI Studio Build App Reverse Proxy

这是一个为 Google AI Studio 的 "Build App" 功能设计的反向代理项目。它允许您通过 API 的方式，调用和使用在 AI Studio 中构建的应用模型。

本项目使用 Playwright 自动化浏览器操作。

---

## 🚀 项目特点

本项目专注于 **Docker 容器化部署**，并在原项目的基础上，利用 AI 进行了深度定制和功能增强，旨在提供一个**更健壮、更稳定、更易于维护**的生产级解决方案。

> **免责声明**: 本仓库的所有代码修改均由 AI 生成，旨在探索自动化编程与应用优化的可能性。请在充分理解代码功能和潜在风险的基础上酌情使用，作者对可能产生的任何问题概不负责。

---

###  🚀Quick Start / 快速开始

要快速启动并运行此项目，请遵循以下步骤。

1.  **[重要] 安装浏览器依赖**:
    本项目依赖 Playwright 来控制一个兼容的 Firefox 浏览器。在执行任何其他操作之前，请先在您的项目根目录下运行以下命令来下载所需的浏览器版本：
    ```bash
    npx playwright install firefox
    ```
    > **注意**: 此步骤仅需在首次设置或 Playwright 更新后执行一次。

2.  📝 **准备 `docker-compose.yml` 文件**:
    在项目根目录创建 `docker-compose.yml`，并粘贴以下内容：
    ```yaml
    version: '3.8'

    services:
      biu_biu_biu:
        image: ghcr.io/junwu-git/biu_biu_biu:latest
        container_name: biu_biu_biu
        restart: unless-stopped
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

3.  🔑 **准备 `.env` 文件**:
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

4.  📁 **创建本地目录与准备认证文件**:
    在项目根目录中，创建 `auth` 和 `debug-screenshots` 目录。
    ```bash
    mkdir auth debug-screenshots
    chmod 777 debug-screenshots # 确保容器有权限写入调试截图
    ```
    本项目依赖于浏览器认证文件。您可以通过运行 `save-auth.js` 脚本来生成这些文件。完成登录后，生成的 `auth-X.json` 文件会自动保存在 `auth` 目录中。

5.  🚀 **启动服务**:
    ```bash
    docker-compose up -d
    ```
