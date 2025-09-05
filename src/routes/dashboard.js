const express = require('express');
const path = require('path');

function createDashboardRouter(serverSystem) {
  const router = express.Router();
  const { logger, config, authSource, requestHandler, stats } = serverSystem;

  // 中间件：保护仪表盘API路由
  const dashboardApiAuth = (req, res, next) => {
    const serverApiKeys = config.apiKeys;
    if (!serverApiKeys || serverApiKeys.length === 0) {
      return next(); // 未配置密钥，跳过认证
    }

    const clientKey = req.headers['x-dashboard-auth'];
    if (clientKey && serverApiKeys.includes(clientKey)) {
      return next();
    }

    logger.warn(`[管理] 拒绝未经授权的仪表盘API请求。IP: ${req.ip}, 路径: ${req.path}`);
    res.status(401).json({ error: { message: 'Unauthorized dashboard access' } });
  };

  // 提供静态文件
  router.use(express.static(path.join(__dirname, '..', 'dashboard')));

  // 提供主页面
  router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dashboard', 'dashboard.html'));
  });

  // 公开端点：用于仪表盘验证API密钥
  router.post('/verify-key', (req, res) => {
    const { key } = req.body;
    const serverApiKeys = config.apiKeys;

    if (!serverApiKeys || serverApiKeys.length === 0) {
      logger.info('[管理] 服务器未配置API密钥，自动授予仪表盘访问权限。');
      return res.json({ success: true });
    }

    if (key && serverApiKeys.includes(key)) {
      logger.info('[管理] 仪表盘API密钥验证成功。');
      return res.json({ success: true });
    }

    logger.warn(`[管理] 仪表盘API密钥验证失败。`);
    res.status(401).json({ success: false, message: '无效的API密钥。' });
  });

  // 受保护的API路由
  const apiRouter = express.Router();
  apiRouter.use(dashboardApiAuth);

  apiRouter.get('/data', (req, res) => {
    res.json({
      status: {
        uptime: process.uptime(),
        streamingMode: serverSystem.streamingMode,
        debugMode: config.debugMode,
        authMode: authSource.authMode,
        apiKeyAuth: (config.apiKeys && config.apiKeys.length > 0) ? '已启用' : '已禁用',
        isAuthSwitching: requestHandler.isAuthSwitching,
        browserConnected: !!serverSystem.browserManager.browser,
        internalWsClients: serverSystem.connectionRegistry.connections.size
      },
      auth: {
        currentAuthIndex: requestHandler.currentAuthIndex,
        accounts: authSource.getAccountDetails(),
        failureCount: requestHandler.failureCount,
      },
      stats: stats,
      config: config
    });
  });

  apiRouter.post('/config', (req, res) => {
    const newConfig = req.body;
    try {
      if (newConfig.hasOwnProperty('streamingMode') && ['real', 'fake'].includes(newConfig.streamingMode)) {
        config.streamingMode = newConfig.streamingMode;
        serverSystem.streamingMode = newConfig.streamingMode;
        requestHandler.serverSystem.streamingMode = newConfig.streamingMode;
      }
      if (newConfig.hasOwnProperty('debugMode') && typeof newConfig.debugMode === 'boolean') {
        config.debugMode = newConfig.debugMode;
      }
      if (newConfig.hasOwnProperty('failureThreshold')) {
        config.failureThreshold = parseInt(newConfig.failureThreshold, 10) || 0;
      }
      if (newConfig.hasOwnProperty('maxRetries')) {
        const retries = parseInt(newConfig.maxRetries, 10);
        config.maxRetries = retries >= 0 ? retries : 3;
        requestHandler.maxRetries = config.maxRetries;
      }
      if (newConfig.hasOwnProperty('retryDelay')) {
        config.retryDelay = parseInt(newConfig.retryDelay, 10) || 2000;
        requestHandler.retryDelay = config.retryDelay;
      }
      if (newConfig.hasOwnProperty('immediateSwitchStatusCodes')) {
        if (Array.isArray(newConfig.immediateSwitchStatusCodes)) {
          config.immediateSwitchStatusCodes = newConfig.immediateSwitchStatusCodes
            .map(c => parseInt(c, 10))
            .filter(c => !isNaN(c));
        }
      }
      logger.info('[管理] 配置已通过仪表盘动态更新。');
      res.status(200).json({ success: true, message: '配置已临时更新。' });
    } catch (error) {
      logger.error(`[管理] 更新配置失败: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  apiRouter.post('/accounts', (req, res) => {
    const { index, authData } = req.body;
    if (!index || !authData) {
      return res.status(400).json({ success: false, message: "必须提供索引和认证数据。" });
    }

    let parsedData;
    try {
      parsedData = (typeof authData === 'string') ? JSON.parse(authData) : authData;
    } catch (e) {
      return res.status(400).json({ success: false, message: "认证数据的JSON格式无效。" });
    }

    const result = authSource.addAccount(parseInt(index, 10), parsedData);
    if (result.success) {
      if (!stats.accountCalls.hasOwnProperty(index)) {
        stats.accountCalls[index] = { total: 0, models: {} };
      }
    }
    res.status(result.success ? 200 : 400).json(result);
  });

  apiRouter.delete('/accounts/:index', (req, res) => {
    const index = parseInt(req.params.index, 10);
    const result = authSource.removeAccount(index);
    res.status(result.success ? 200 : 400).json(result);
  });

  router.use(apiRouter);

  return router;
}

module.exports = createDashboardRouter;