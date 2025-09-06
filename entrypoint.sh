#!/bin/sh
set -e

# --- 优雅停机函数 ---
graceful_shutdown() {
  echo "收到停机信号，正在优雅地关闭 Node.js 应用..."
  # 向子进程（Node.js 应用）发送 SIGTERM 信号
  # $$ 是当前脚本的 PID，但由于我们使用 exec，Node.js 进程会替换 sh 进程。
  # 我们需要找到作为子进程运行的 Node.js 进程。
  # 使用 pgrep 查找由 gosu 启动的、作为当前脚本子进程的 node 进程。
  NODE_PID=$(pgrep -P $$ -f "node")
  if [ -n "$NODE_PID" ]; then
    kill -TERM "$NODE_PID"
    # 等待 Node.js 进程退出
    wait "$NODE_PID"
  fi
  echo "Node.js 应用已关闭。"
  exit 0
}

# 捕获 SIGTERM 和 SIGINT 信号
trap 'graceful_shutdown' SIGTERM SIGINT

# --- 用户权限管理 ---
TARGET_UID=${TARGET_UID:-1001}
TARGET_GID=${TARGET_GID:-1001}
CURRENT_UID=$(id -u node)
CURRENT_GID=$(id -g node)

echo "启动 entrypoint 脚本..."
echo "主机用户期望 UID: ${TARGET_UID}, GID: ${TARGET_GID}"
echo "容器内当前 node 的 UID: ${CURRENT_UID}, GID: ${CURRENT_GID}"

# 在新版 Dockerfile 中，我们直接创建了 node 用户，所以这里不再需要复杂的 ID 修改逻辑。
# 我们只需要确保工作目录的权限是正确的。

# --- 权限修复 ---
echo "正在修复挂载目录的所有权..."
# 使用 chown -R 确保 node 用户拥有对这些目录的完全访问权限
# /home/node/app 是新的工作目录
chown -R node:node /app/auth
chown -R node:node /app/debug-screenshots
echo "权限修复完成。"

# --- 执行主命令 ---
echo "切换到 'node' 用户并执行主命令: $*"
# 使用 exec gosu 切换用户并执行 CMD
# 将脚本作为后台进程运行，以便 trap 可以捕获信号
exec gosu node "$@" &

# 等待后台进程结束
wait $!