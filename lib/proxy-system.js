const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const AuthSource = require('./auth-source');
const BrowserManager = require('./browser-manager');
const RequestHandler = require('./request-handler');
const { LoggingService, ConnectionRegistry } = require('./utils');

class ProxyServerSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService('ProxySystem');
    this._loadConfiguration();
    this.streamingMode = this.config.streamingMode;

    this.stats = {
      totalCalls: 0,
      totalCallsCacheHit: 0,
      accountCalls: {}
    };

    this.authSource = new AuthSource(this.logger);
    this.browserManager = new BrowserManager(this.logger, this.config, this.authSource);
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this, this.connectionRegistry, this.logger, this.browserManager, this.config, this.authSource);

    this.httpServer = null;
    this.wsServer = null;
  }

  _loadConfiguration() {
    let config = {
      httpPort: 8889, host: '0.0.0.0', wsPort: 9998, streamingMode: 'real',
      failureThreshold: 0,
      maxRetries: 3, retryDelay: 2000, browserExecutablePath: null,
      apiKeys: [],
      immediateSwitchStatusCodes: [],
      initialAuthIndex: null,
      debugMode: false,
      redisUrl: null,
      cacheTTL: 300,
    };

    const configPath = path.join(__dirname, '..', 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        config = { ...config, ...fileConfig };
        this.logger.info('[系统] 已从 config.json 加载配置。');
      }
    } catch (error) {
      this.logger.warn(`[系统] 无法读取或解析 config.json: ${error.message}`);
    }

    if (process.env.PORT) config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.STREAMING_MODE) config.streamingMode = process.env.STREAMING_MODE;
    if (process.env.FAILURE_THRESHOLD) config.failureThreshold = parseInt(process.env.FAILURE_THRESHOLD, 10) || config.failureThreshold;
    if (process.env.MAX_RETRIES) config.maxRetries = parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
    if (process.env.RETRY_DELAY) config.retryDelay = parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
    if (process.env.CAMOUFOX_EXECUTABLE_PATH) config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    if (process.env.API_KEYS) {
      config.apiKeys = process.env.API_KEYS.split(',');
    }
    if (process.env.DEBUG_MODE) {
      config.debugMode = process.env.DEBUG_MODE === 'true';
    }
    if (process.env.INITIAL_AUTH_INDEX) {
      const envIndex = parseInt(process.env.INITIAL_AUTH_INDEX, 10);
      if (!isNaN(envIndex) && envIndex > 0) {
        config.initialAuthIndex = envIndex;
      }
    }
    if (process.env.REDIS_URL) config.redisUrl = process.env.REDIS_URL;
    if (process.env.CACHE_TTL) config.cacheTTL = parseInt(process.env.CACHE_TTL, 10) || config.cacheTTL;


    let rawCodes;
    let codesSource;

    if (process.env.IMMEDIATE_SWITCH_STATUS_CODES) {
        rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
        codesSource = '环境变量';
    } else if (config.immediateSwitchStatusCodes && Array.isArray(config.immediateSwitchStatusCodes)) {
        rawCodes = config.immediateSwitchStatusCodes.join(',');
        codesSource = 'config.json 文件';
    }

    if (rawCodes && typeof rawCodes === 'string') {
      config.immediateSwitchStatusCodes = rawCodes
        .split(',')
        .map(code => parseInt(String(code).trim(), 10))
        .filter(code => !isNaN(code) && code >= 400 && code <= 599);
      if (config.immediateSwitchStatusCodes.length > 0) {
        this.logger.info(`[系统] 已从 ${codesSource} 加载“立即切换状态码”。`);
      }
    } else {
      config.immediateSwitchStatusCodes = [];
    }

    if (Array.isArray(config.apiKeys)) {
      config.apiKeys = config.apiKeys.map(k => String(k).trim()).filter(k => k);
    } else {
      config.apiKeys = [];
    }

    this.config = config;
    this.logger.info('================ [ 生效配置 ] ================');
    this.logger.info(`  HTTP 服务端口: ${this.config.httpPort}`);
    this.logger.info(`  监听地址: ${this.config.host}`);
    this.logger.info(`  流式模式: ${this.config.streamingMode}`);
    this.logger.info(`  调试模式: ${this.config.debugMode ? '已开启' : '已关闭'}`);
    if (this.config.initialAuthIndex) {
      this.logger.info(`  指定初始认证索引: ${this.config.initialAuthIndex}`);
    }
    if (this.config.redisUrl) {
      this.logger.info(`  Redis 缓存: 已启用 (TTL: ${this.config.cacheTTL}秒)`);
      const redisUrlParts = this.config.redisUrl.split('@');
      const displayRedisUrl = redisUrlParts.length > 1 ? `***@${redisUrlParts[1]}` : this.config.redisUrl;
      this.logger.info(`  Redis URL: ${displayRedisUrl}`);
    } else {
      this.logger.info(`  Redis 缓存: 已禁用`);
    }
    this.logger.info(`  失败计数切换: ${this.config.failureThreshold > 0 ? `连续 ${this.config.failureThreshold} 次失败后切换` : '已禁用'}`);
    this.logger.info(`  立即切换状态码: ${this.config.immediateSwitchStatusCodes.length > 0 ? this.config.immediateSwitchStatusCodes.join(', ') : '已禁用'}`);
    this.logger.info(`  单次请求最大重试: ${this.config.maxRetries}次`);
    this.logger.info(`  重试间隔: ${this.config.retryDelay}ms`);
    if (this.config.apiKeys && this.config.apiKeys.length > 0) {
      this.logger.info(`  API 密钥认证: 已启用 (${this.config.apiKeys.length} 个密钥)`);
    } else {
      this.logger.info(`  API 密钥认证: 已禁用`);
    }
    this.logger.info('=============================================================');
  }

  async start() {
    try {
      this.authSource.getAvailableIndices().forEach(index => {
        this.stats.accountCalls[index] = { total: 0, models: {} };
      });

      let startupIndex = this.authSource.getFirstAvailableIndex();
      const suggestedIndex = this.config.initialAuthIndex;

      if (suggestedIndex) {
        if (this.authSource.getAvailableIndices().includes(suggestedIndex)) {
          this.logger.info(`[系统] 使用配置中指定的有效启动索引: ${suggestedIndex}`);
          startupIndex = suggestedIndex;
        } else {
          this.logger.warn(`[系统] 配置中指定的启动索引 ${suggestedIndex} 无效或不存在，将使用第一个可用索引: ${startupIndex}`);
        }
      } else {
        this.logger.info(`[系统] 未指定启动索引，将自动使用第一个可用索引: ${startupIndex}`);
      }

      await this.browserManager.launchBrowser(startupIndex);
      await this._startHttpServer();
      await this._startWebSocketServer();
      this.logger.info(`[系统] 代理服务器系统启动完成。`);
      this.emit('started');
    } catch (error) {
      this.logger.error(`[系统] 启动失败: ${error.message}`);
      this.emit('error', error);
      process.exit(1);
    }
  }

  _createDebugLogMiddleware() {
    return (req, res, next) => {
      if (!this.config.debugMode) {
        return next();
      }

      const requestId = this.requestHandler._generateRequestId();
      const log = this.logger.info.bind(this.logger);

      log(`\n\n--- [调试] 开始处理入站请求 (${requestId}) ---`);
      log(`[调试][${requestId}] 客户端 IP: ${req.ip}`);
      log(`[调试][${requestId}] 方法: ${req.method}`);
      log(`[调试][${requestId}] URL: ${req.originalUrl}`);
      log(`[调试][${requestId}] 请求头: ${JSON.stringify(req.headers, null, 2)}`);

      let bodyContent = '无或空';
      if (req.body) {
        if (Buffer.isBuffer(req.body) && req.body.length > 0) {
          try {
            bodyContent = JSON.stringify(JSON.parse(req.body.toString('utf-8')), null, 2);
          } catch {
            bodyContent = `[无法解析为JSON的Buffer, 大小: ${req.body.length} 字节]`;
          }
        } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
          bodyContent = JSON.stringify(req.body, null, 2);
        }
      }

      log(`[调试][${requestId}] 请求体:\n${bodyContent}`);
      log(`--- [调试] 结束处理入站请求 (${requestId}) ---\n\n`);

      next();
    };
  }


  _createAuthMiddleware() {
    return (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next();
      }

      const headers = req.headers;
      let clientKey = null;
      let keySource = null;

      const xGoogApiKey = headers['x-goog-api-key'] || headers['x_goog_api_key'];
      if (xGoogApiKey) {
        clientKey = xGoogApiKey;
        keySource = 'x-goog-api-key 请求头';
      }

      const authHeader = headers.authorization;
      if (!clientKey && authHeader && authHeader.startsWith('Bearer ')) {
        clientKey = authHeader.substring(7);
        keySource = 'Authorization 请求头';
      }

      const xApiKey = headers['x-api-key'] || headers['x_api_key'];
      if (!clientKey && xApiKey) {
        clientKey = xApiKey;
        keySource = 'X-API-Key 请求头';
      }

      if (!clientKey && req.query.key) {
        clientKey = req.query.key;
        keySource = '查询参数';
      }

      if (clientKey) {
        if (serverApiKeys.includes(clientKey)) {
          if (this.config.debugMode) {
            this.logger.debug(`[认证][调试] 在 '${keySource}' 中找到API密钥，验证通过。`);
          }
          if (keySource === '查询参数') {
            delete req.query.key;
          }
          return next();
        } else {
          if (this.config.debugMode) {
            this.logger.warn(`[认证][调试] 拒绝请求: 无效的API密钥。IP: ${req.ip}, 路径: ${req.path}`);
            this.logger.debug(`[认证][调试] 来源: ${keySource}`);
            this.logger.debug(`[认证][调试] 提供的错误密钥: '${clientKey}'`);
            this.logger.debug(`[认证][调试] 已加载的有效密钥: [${serverApiKeys.join(', ')}]`);
          } else {
            this.logger.warn(`[认证] 拒绝请求: 无效的API密钥。IP: ${req.ip}, 路径: ${req.path}`);
          }
          return res.status(401).json({ error: { message: "提供了无效的API密钥。" } });
        }
      }

      this.logger.warn(`[认证] 拒绝受保护的请求: 缺少API密钥。IP: ${req.ip}, 路径: ${req.path}`);

      if (this.config.debugMode) {
        this.logger.debug(`[认证][调试] 未在任何标准位置找到API密钥。`);
        this.logger.debug(`[认证][调试] 搜索的请求头: ${JSON.stringify(headers, null, 2)}`);
        this.logger.debug(`[认证][调试] 搜索的查询参数: ${JSON.stringify(req.query)}`);
        this.logger.debug(`[认证][调试] 已加载的有效密钥: [${serverApiKeys.join(', ')}]`);
      }

      return res.status(401).json({ error: { message: "访问被拒绝。未在请求头或查询参数中找到有效的API密钥。" } });
    };
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(`[系统] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`);
        this.logger.info(`[系统] 仪表盘可在 http://${this.config.host}:${this.config.httpPort}/dashboard 访问`);
        resolve();
      });
    });
  }

  _createExpressApp() {
    const app = express();
    app.use(express.json({ limit: '100mb' }));
    app.use(express.raw({ type: '*/*', limit: '100mb' }));
    app.use((req, res, next) => {
      if (req.is('application/json') && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        // Already parsed correctly by express.json()
      } else if (Buffer.isBuffer(req.body)) {
        const bodyStr = req.body.toString('utf-8');
        if (bodyStr) {
          try {
            req.body = JSON.parse(bodyStr);
          } catch {
            // Not JSON, leave as buffer.
          }
        }
      }
      next();
    });

    app.use(this._createDebugLogMiddleware());

    app.get('/', (req, res) => {
        res.redirect('/dashboard');
    });

    app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));

    app.post('/dashboard/verify-key', (req, res) => {
      const { key } = req.body;
      const serverApiKeys = this.config.apiKeys;

      if (!serverApiKeys || serverApiKeys.length === 0) {
        this.logger.info('[管理] 服务器未配置API密钥，自动授予仪表盘访问权限。');
        return res.json({ success: true });
      }

      if (key && serverApiKeys.includes(key)) {
        this.logger.info('[管理] 仪表盘API密钥验证成功。');
        return res.json({ success: true });
      }

      this.logger.warn(`[管理] 仪表盘API密钥验证失败。`);
      res.status(401).json({ success: false, message: '无效的API密钥。' });
    });

    const dashboardApiAuth = (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next();
      }

      const clientKey = req.headers['x-dashboard-auth'];
      if (clientKey && serverApiKeys.includes(clientKey)) {
        return next();
      }

      this.logger.warn(`[管理] 拒绝未经授权的仪表盘API请求。IP: ${req.ip}, 路径: ${req.path}`);
      res.status(401).json({ error: { message: 'Unauthorized dashboard access' } });
    };

    const dashboardApiRouter = express.Router();
    dashboardApiRouter.use(dashboardApiAuth);

    dashboardApiRouter.get('/data', (req, res) => {
      res.json({
        status: {
          uptime: process.uptime(),
          streamingMode: this.streamingMode,
          debugMode: this.config.debugMode,
          authMode: this.authSource.authMode,
          apiKeyAuth: (this.config.apiKeys && this.config.apiKeys.length > 0) ? '已启用' : '已禁用',
          isAuthSwitching: this.requestHandler.isAuthSwitching,
          browserConnected: !!this.browserManager.browser,
          internalWsClients: this.connectionRegistry.connections.size
        },
        auth: {
          currentAuthIndex: this.requestHandler.currentAuthIndex,
          accounts: this.authSource.getAccountDetails(),
          failureCount: this.requestHandler.failureCount,
        },
        stats: this.stats,
        config: this.config
      });
    });

    dashboardApiRouter.post('/config', (req, res) => {
      const newConfig = req.body;
      try {
        if (Object.prototype.hasOwnProperty.call(newConfig, 'streamingMode') && ['real', 'fake'].includes(newConfig.streamingMode)) {
          this.config.streamingMode = newConfig.streamingMode;
          this.streamingMode = newConfig.streamingMode;
        }
        if (Object.prototype.hasOwnProperty.call(newConfig, 'debugMode') && typeof newConfig.debugMode === 'boolean') {
          this.config.debugMode = newConfig.debugMode;
        }
        if (Object.prototype.hasOwnProperty.call(newConfig, 'failureThreshold')) {
          this.config.failureThreshold = parseInt(newConfig.failureThreshold, 10) || 0;
        }
        if (Object.prototype.hasOwnProperty.call(newConfig, 'maxRetries')) {
          const retries = parseInt(newConfig.maxRetries, 10);
          this.config.maxRetries = retries >= 0 ? retries : 3;
          this.requestHandler.maxRetries = this.config.maxRetries;
        }
        if (Object.prototype.hasOwnProperty.call(newConfig, 'retryDelay')) {
          this.config.retryDelay = parseInt(newConfig.retryDelay, 10) || 2000;
          this.requestHandler.retryDelay = this.config.retryDelay;
        }
        if (Object.prototype.hasOwnProperty.call(newConfig, 'immediateSwitchStatusCodes')) {
          if (Array.isArray(newConfig.immediateSwitchStatusCodes)) {
            this.config.immediateSwitchStatusCodes = newConfig.immediateSwitchStatusCodes
              .map(c => parseInt(c, 10))
              .filter(c => !isNaN(c));
          }
        }
        this.logger.info('[管理] 配置已通过仪表盘动态更新。');
        res.status(200).json({ success: true, message: '配置已临时更新。' });
      } catch (error) {
        this.logger.error(`[管理] 更新配置失败: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    dashboardApiRouter.post('/accounts', (req, res) => {
      const { index, authData } = req.body;
      if (!index || !authData) {
        return res.status(400).json({ success: false, message: "必须提供索引和认证数据。" });
      }

      let parsedData;
      try {
        parsedData = (typeof authData === 'string') ? JSON.parse(authData) : authData;
      } catch {
        return res.status(400).json({ success: false, message: "认证数据的JSON格式无效。" });
      }

      const result = this.authSource.addAccount(parseInt(index, 10), parsedData);
      if (result.success) {
        if (!Object.prototype.hasOwnProperty.call(this.stats.accountCalls, index)) {
          this.stats.accountCalls[index] = { total: 0, models: {} };
        }
      }
      res.status(result.success ? 200 : 400).json(result);
    });

    dashboardApiRouter.delete('/accounts/:index', (req, res) => {
      const index = parseInt(req.params.index, 10);
      const result = this.authSource.removeAccount(index);
      res.status(result.success ? 200 : 400).json(result);
    });

    dashboardApiRouter.post('/cache/clear', async (req, res) => {
      this.logger.info('[管理] 接到 /cache/clear 请求，手动触发缓存清除。');
      const result = await this.requestHandler.clearCache();
      res.status(result.success ? 200 : 500).json(result);
    });

    app.use('/dashboard', dashboardApiRouter);

    app.post('/switch', dashboardApiAuth, async (req, res) => {
      this.logger.info('[管理] 接到 /switch 请求，手动触发账号切换。');
      if (this.requestHandler.isAuthSwitching) {
        const msg = '账号切换已在进行中，请稍后。';
        this.logger.warn(`[管理] /switch 请求被拒绝: ${msg}`);
        return res.status(429).send(msg);
      }
      const oldIndex = this.requestHandler.currentAuthIndex;
      try {
        await this.requestHandler._switchToNextAuth();
        const newIndex = this.requestHandler.currentAuthIndex;
        const message = `成功将账号从索引 ${oldIndex} 切换到 ${newIndex}。`;
        this.logger.info(`[管理] 手动切换成功。 ${message}`);
        res.status(200).send(message);
      } catch (error) {
        const errorMessage = `切换账号失败: ${error.message}`;
        this.logger.error(`[管理] 手动切换失败。错误: ${errorMessage}`);
        res.status(500).send(errorMessage);
      }
    });

    app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'healthy',
        uptime: process.uptime(),
        config: {
          streamingMode: this.streamingMode,
          debugMode: this.config.debugMode,
          failureThreshold: this.config.failureThreshold,
          immediateSwitchStatusCodes: this.config.immediateSwitchStatusCodes,
          maxRetries: this.config.maxRetries,
          authMode: this.authSource.authMode,
          apiKeyAuth: (this.config.apiKeys && this.config.apiKeys.length > 0) ? '已启用' : '已禁用',
        },
        auth: {
          currentAuthIndex: this.requestHandler.currentAuthIndex,
          availableIndices: this.authSource.getAvailableIndices(),
          totalAuthSources: this.authSource.getAvailableIndices().length,
          failureCount: this.requestHandler.failureCount,
          isAuthSwitching: this.requestHandler.isAuthSwitching,
        },
        stats: this.stats,
        browser: {
          connected: !!this.browserManager.browser,
        },
        websocket: {
          internalClients: this.connectionRegistry.connections.size
        }
      });
    });

    app.use(this._createAuthMiddleware());
    app.all(/(.*)/, (req, res) => {
      if (req.path === '/' || req.path === '/favicon.ico' || req.path.startsWith('/dashboard')) {
        return res.status(204).send();
      }
      this.requestHandler.processRequest(req, res);
    });

    return app;
  }

  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({ port: this.config.wsPort, host: this.config.host });
    this.wsServer.on('connection', (ws, req) => {
      this.connectionRegistry.addConnection(ws, { address: req.socket.remoteAddress });
    });
  }
}

module.exports = ProxyServerSystem;