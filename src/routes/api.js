const express = require('express');

function createApiRouter(serverSystem) {
  const router = express.Router();
  const { logger, requestHandler, authSource, browserManager, connectionRegistry, stats, config } = serverSystem;

  // 保护 /switch 路由
  const switchAuth = (req, res, next) => {
    const serverApiKeys = config.apiKeys;
    if (!serverApiKeys || serverApiKeys.length === 0) {
      return next(); // 未配置密钥，跳过认证
    }

    const clientKey = req.headers['x-dashboard-auth'];
    if (clientKey && serverApiKeys.includes(clientKey)) {
      return next();
    }

    logger.warn(`[管理] 拒绝未经授权的 /switch 请求。IP: ${req.ip}`);
    res.status(401).json({ error: { message: 'Unauthorized' } });
  };

  router.post('/switch', switchAuth, async (req, res) => {
    logger.info('[管理] 接到 /switch 请求，手动触发账号切换。');
    if (requestHandler.isAuthSwitching) {
      const msg = '账号切换已在进行中，请稍后。';
      logger.warn(`[管理] /switch 请求被拒绝: ${msg}`);
      return res.status(429).send(msg);
    }
    const oldIndex = requestHandler.currentAuthIndex;
    try {
      await requestHandler._switchToNextAuth();
      const newIndex = requestHandler.currentAuthIndex;
      const message = `成功将账号从索引 ${oldIndex} 切换到 ${newIndex}。`;
      logger.info(`[管理] 手动切换成功。 ${message}`);
      res.status(200).send(message);
    } catch (error) {
      const errorMessage = `切换账号失败: ${error.message}`;
      logger.error(`[管理] 手动切换失败。错误: ${errorMessage}`);
      res.status(500).send(errorMessage);
    }
  });

  router.get('/health', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      uptime: process.uptime(),
      config: {
        streamingMode: serverSystem.streamingMode,
        debugMode: config.debugMode,
        failureThreshold: config.failureThreshold,
        immediateSwitchStatusCodes: config.immediateSwitchStatusCodes,
        maxRetries: config.maxRetries,
        authMode: authSource.authMode,
        apiKeyAuth: (config.apiKeys && config.apiKeys.length > 0) ? '已启用' : '已禁用',
      },
      auth: {
        currentAuthIndex: requestHandler.currentAuthIndex,
        availableIndices: authSource.getAvailableIndices(),
        totalAuthSources: authSource.getAvailableIndices().length,
        failureCount: requestHandler.failureCount,
        isAuthSwitching: requestHandler.isAuthSwitching,
      },
      stats: stats,
      browser: {
        connected: !!browserManager.browser,
      },
      websocket: {
        internalClients: connectionRegistry.connections.size
      }
    });
  });

  // 主API代理
  router.all(/(.*)/, (req, res) => {
    // 修改: 增加对根路径的判断，防止其被代理
    if (req.path === '/' || req.path === '/favicon.ico') {
      return res.status(204).send();
    }
    requestHandler.processRequest(req, res);
  });

  return router;
}

module.exports = createApiRouter;