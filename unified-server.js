const ProxyServerSystem = require('./lib/proxy-system');

async function initializeServer() {
  try {
    const serverSystem = new ProxyServerSystem();
    await serverSystem.start();
  } catch (error) {
    console.error('❌ 服务器启动失败:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, initializeServer };