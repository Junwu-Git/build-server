const ProxyServerSystem = require('./lib/proxy-system');

let serverSystem;

async function initializeServer() {
  try {
    serverSystem = new ProxyServerSystem();
    await serverSystem.start();
  } catch (error) {
    console.error('❌ 服务器启动失败:', error.message);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`\n收到 ${signal} 信号，开始优雅停机...`);
  if (serverSystem) {
    try {
      await serverSystem.stop();
      console.log('服务已成功关闭。');
      process.exit(0);
    } catch (error) {
      console.error('❌ 停机过程中发生错误:', error.message);
      process.exit(1);
    }
  } else {
    console.log('服务器尚未初始化，直接退出。');
    process.exit(0);
  }
}

if (require.main === module) {
  // 监听停机信号
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  initializeServer();
}

module.exports = { ProxyServerSystem, initializeServer };