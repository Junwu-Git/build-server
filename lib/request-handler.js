const Redis = require('ioredis');

class RequestHandler {
  constructor(serverSystem, connectionRegistry, logger, browserManager, config, authSource) {
    this.serverSystem = serverSystem;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.config = config;
    this.authSource = authSource;
    this.maxRetries = this.config.maxRetries;
    this.retryDelay = this.config.retryDelay;
    this.failureCount = 0;
    this.isAuthSwitching = false;
    this.fullCycleFailure = false;
    this.startOfFailureCycleIndex = null;

    this.redisClient = null;
    if (config.redisUrl) {
        this.redisClient = new Redis(config.redisUrl);
        this.redisClient.on('connect', () => this.logger.info('[Redis] 已连接到 Redis 服务器。'));
        this.redisClient.on('error', (err) => this.logger.error(`[Redis] Redis 连接错误: ${err.message}`));
        this.logger.info(`[缓存] Redis 缓存功能已启用 (TTL: ${this.config.cacheTTL}秒)。`);
    } else {
        this.logger.info('[缓存] Redis 缓存功能已禁用 (未配置 REDIS_URL)。');
    }
    this.cacheTTL = config.cacheTTL;
  }

  get currentAuthIndex() {
    return this.browserManager.currentAuthIndex;
  }

  _getNextAuthIndex() {
    const available = this.authSource.getAvailableIndices();
    if (available.length === 0) return null;
    if (available.length === 1) return available;

    const currentIndexInArray = available.indexOf(this.currentAuthIndex);

    if (currentIndexInArray === -1) {
      this.logger.warn(`[认证] 当前索引 ${this.currentAuthIndex} 不在可用列表中，将切换到第一个可用索引。`);
      return available;
    }

    const nextIndexInArray = (currentIndexInArray + 1) % available.length;
    return available[nextIndexInArray];
  }

  async _switchToNextAuth() {
    if (this.isAuthSwitching) {
      this.logger.info('🔄 [认证] 正在切换账号，跳过重复切换');
      return;
    }

    this.isAuthSwitching = true;
    const nextAuthIndex = this._getNextAuthIndex();
    const totalAuthCount = this.authSource.getAvailableIndices().length;

    if (this.fullCycleFailure) {
        this.logger.error('🔴 [认证] 已检测到全账号循环失败，将暂停自动切换以防止资源过载。请检查所有账号有效性或服务状态。');
        this.isAuthSwitching = false;
        throw new Error('全账号循环失败，自动切换已熔断。');
    }
    
    if (this.startOfFailureCycleIndex !== null && nextAuthIndex === this.startOfFailureCycleIndex) {
        this.logger.error('🔴 [认证] 已完成一整轮账号切换但问题依旧，触发全循环失败熔断机制！');
        this.fullCycleFailure = true;
    }

    if (nextAuthIndex === null) {
      this.logger.error('🔴 [认证] 无法切换账号，因为没有可用的认证源！');
      this.isAuthSwitching = false;
      throw new Error('没有可用的认证源可以切换。');
    }

    this.logger.info('==================================================');
    this.logger.info(`🔄 [认证] 开始账号切换流程`);
    this.logger.info(`   • 失败次数: ${this.failureCount}/${this.config.failureThreshold > 0 ? this.config.failureThreshold : 'N/A'}`);
    this.logger.info(`   • 当前账号索引: ${this.currentAuthIndex}`);
    this.logger.info(`   • 目标账号索引: ${nextAuthIndex}`);
    this.logger.info(`   • 可用账号总数: ${totalAuthCount}`);
    this.logger.info('==================================================');

    try {
      await this.browserManager.switchAccount(nextAuthIndex);
      this.failureCount = 0;
      this.fullCycleFailure = false;
      this.startOfFailureCycleIndex = null;
      this.logger.info('==================================================');
      this.logger.info(`✅ [认证] 成功切换到账号索引 ${this.currentAuthIndex}`);
      this.logger.info(`✅ [认证] 失败计数已重置为0，熔断机制已重置。`);
      this.logger.info('==================================================');
    } catch (error) {
      this.logger.error('==================================================');
      this.logger.error(`❌ [认证] 切换账号失败: ${error.message}`);
      this.logger.error('==================================================');
      throw error;
    } finally {
      this.isAuthSwitching = false;
    }
  }

  _parseAndCorrectErrorDetails(errorDetails) {
    const correctedDetails = { ...errorDetails };
    this.logger.debug(`[错误解析器] 原始错误详情: status=${correctedDetails.status}, message="${correctedDetails.message}"`);

    if (correctedDetails.message && typeof correctedDetails.message === 'string') {
      const regex = /(?:HTTP|status code)\s+(\d{3})/;
      const match = correctedDetails.message.match(regex);

      if (match && match) {
        const parsedStatus = parseInt(match, 10);
        if (parsedStatus >= 400 && parsedStatus <= 599) {
          if (correctedDetails.status !== parsedStatus) {
            this.logger.warn(`[错误解析器] 修正了错误状态码！原始: ${correctedDetails.status}, 从消息中解析得到: ${parsedStatus}`);
            correctedDetails.status = parsedStatus;
          } else {
            this.logger.debug(`[错误解析器] 解析的状态码 (${parsedStatus}) 与原始状态码一致，无需修正。`);
          }
        }
      }
    }
    return correctedDetails;
  }

  async _handleRequestFailureAndSwitch(errorDetails, res) {
    if (this.config.debugMode) {
      this.logger.debug(`[认证][调试] 收到来自浏览器的完整错误详情:\n${JSON.stringify(errorDetails, null, 2)}`);
    }

    const correctedDetails = { ...errorDetails };
    if (correctedDetails.message && typeof correctedDetails.message === 'string') {
      const regex = /(?:HTTP|status code)\s*(\d{3})|"code"\s*:\s*(\d{3})/;
      const match = correctedDetails.message.match(regex);
      const parsedStatusString = match ? (match || match) : null;

      if (parsedStatusString) {
        const parsedStatus = parseInt(parsedStatusString, 10);
        if (parsedStatus >= 400 && parsedStatus <= 599 && correctedDetails.status !== parsedStatus) {
          this.logger.warn(`[认证] 修正了错误状态码！原始: ${correctedDetails.status}, 从消息中解析得到: ${parsedStatus}`);
          correctedDetails.status = parsedStatus;
        }
      }
    }

    if (this.fullCycleFailure) {
        this.logger.warn('[认证] 熔断已触发，跳过失败计数和切换逻辑。');
        return;
    }
    
    const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(correctedDetails.status);

    if (isImmediateSwitch) {
      this.logger.warn(`🔴 [认证] 收到状态码 ${correctedDetails.status} (已修正)，触发立即切换账号...`);
      if (res) this._sendErrorChunkToClient(res, `收到状态码 ${correctedDetails.status}，正在尝试切换账号...`);
      try {
        await this._switchToNextAuth();
        if (res) this._sendErrorChunkToClient(res, `已切换到账号索引 ${this.currentAuthIndex}，请重试`);
      } catch (switchError) {
        this.logger.error(`🔴 [认证] 账号切换失败: ${switchError.message}`);
        if (res) this._sendErrorChunkToClient(res, `切换账号失败: ${switchError.message}`);
      }
      return;
    }

    if (this.config.failureThreshold > 0) {
      this.failureCount++;
      this.logger.warn(`⚠️ [认证] 请求失败 - 失败计数: ${this.failureCount}/${this.config.failureThreshold} (当前账号索引: ${this.currentAuthIndex}, 状态码: ${correctedDetails.status})`);

      if (this.failureCount >= this.config.failureThreshold && this.startOfFailureCycleIndex === null) {
          this.logger.info(`[认证] 启动失败循环检测，起始账号索引为: ${this.currentAuthIndex}`);
          this.startOfFailureCycleIndex = this.currentAuthIndex;
      }
      
      if (this.failureCount >= this.config.failureThreshold) {
        this.logger.warn(`🔴 [认证] 达到失败阈值！准备切换账号...`);
        if (res) this._sendErrorChunkToClient(res, `连续失败${this.failureCount}次，正在尝试切换账号...`);
        try {
          await this._switchToNextAuth();
          if (res) this._sendErrorChunkToClient(res, `已切换到账号索引 ${this.currentAuthIndex}，请重试`);
        } catch (switchError) {
          this.logger.error(`🔴 [认证] 账号切换失败: ${switchError.message}`);
          if (res) this._sendErrorChunkToClient(res, `切换账号失败: ${switchError.message}`);
        }
      }
    } else {
      this.logger.warn(`[认证] 请求失败 (状态码: ${correctedDetails.status})。基于计数的自动切换已禁用 (failureThreshold=0)`);
    }
  }


  _getModelFromRequest(req) {
    let body = req.body;

    if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf-8'));
      } catch (e) { body = {}; }
    } else if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) { body = {}; }
    }

    if (body && typeof body === 'object') {
      if (body.model) return body.model;
      if (body.generation_config && body.generation_config.model) return body.generation_config.model;
    }

    const match = req.path.match(/\/models\/([^/:]+)/);
    if (match && match) {
      return match;
    }
    return 'unknown_model';
  }

  async processRequest(req, res) {
    if ((!this.config.apiKeys || this.config.apiKeys.length === 0) && req.query && req.query.hasOwnProperty('key')) {
      if (this.config.debugMode) {
        this.logger.debug(`[请求预处理] 服务器API密钥认证已禁用。检测到并移除了来自客户端的 'key' 查询参数 (值为: '${req.query.key}')。`);
      }
      delete req.query.key;
    }

    const modelName = this._getModelFromRequest(req);
    const currentAccount = this.currentAuthIndex;

    this.logger.info(`[请求] ${req.method} ${req.path} | 账号: ${currentAccount} | 模型: 🤖 ${modelName}`);

    this.serverSystem.stats.totalCalls++;
    if (this.serverSystem.stats.accountCalls[currentAccount]) {
      this.serverSystem.stats.accountCalls[currentAccount].total = (this.serverSystem.stats.accountCalls[currentAccount].total || 0) + 1;
      this.serverSystem.stats.accountCalls[currentAccount].models[modelName] = (this.serverSystem.stats.accountCalls[currentAccount].models[modelName] || 0) + 1;
    } else {
      this.serverSystem.stats.accountCalls[currentAccount] = {
        total: 1,
        models: { [modelName]: 1 }
      };
    }

    const isCacheableGet = req.method === 'GET' && !req.path.includes(':stream') && this.redisClient && this.config.cacheTTL > 0;
    
    if (isCacheableGet) {
      const cacheKey = this._generateCacheKey(req);
      try {
          const cachedResponse = await this.redisClient.get(cacheKey);

          if (cachedResponse) {
            this.logger.info(`[缓存] 命中 Redis 缓存: ${cacheKey}`);
            const parsedCache = JSON.parse(cachedResponse);
            this._sendCachedResponse(parsedCache, res);
            this.serverSystem.stats.totalCallsCacheHit = (this.serverSystem.stats.totalCallsCacheHit || 0) + 1;
            return;
          }
      } catch (redisErr) {
          this.logger.error(`[缓存] 读取 Redis 缓存失败: ${redisErr.message}。将继续执行正常请求。`);
      }
    }

    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, '没有可用的浏览器连接');
    }
    const requestId = this._generateRequestId();
    const proxyRequest = this._buildProxyRequest(req, requestId);
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);

    try {
      if (this.serverSystem.streamingMode === 'fake') {
        const responseData = await this._handlePseudoStreamResponse(proxyRequest, messageQueue, req, res);

        if (isCacheableGet && responseData && responseData.body) {
            const cacheKey = this._generateCacheKey(req);
            try {
                await this.redisClient.setex(cacheKey, this.config.cacheTTL, JSON.stringify(responseData));
                this.logger.debug(`[缓存] 成功存储 Redis 缓存: ${cacheKey}`);
            } catch (redisErr) {
                this.logger.error(`[缓存] 存储 Redis 缓存失败: ${redisErr.message}。缓存未写入。`);
            }
        }
      } else {
        await this._handleRealStreamResponse(proxyRequest, messageQueue, req, res);
      }
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
    }
  }

  _generateRequestId() { return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`; }
  _buildProxyRequest(req, requestId) {
    const proxyRequest = {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      request_id: requestId,
      streaming_mode: this.serverSystem.streamingMode
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let requestBodyString;
      if (typeof req.body === 'object' && req.body !== null) {
        requestBodyString = JSON.stringify(req.body);
      } else if (typeof req.body === 'string') {
        requestBodyString = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        requestBodyString = req.body.toString('utf-8');
      } else {
        requestBodyString = '';
      }
      proxyRequest.body = requestBodyString;
    }

    return proxyRequest;
  }
  _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      connection.send(JSON.stringify(proxyRequest));
    } else {
      throw new Error("无法转发请求：没有可用的WebSocket连接。");
    }
  }
  _sendErrorChunkToClient(res, errorMessage) {
    const errorPayload = {
      error: { message: `[代理系统提示] ${errorMessage}`, type: 'proxy_error', code: 'proxy_error' }
    };
    const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
    if (res && !res.writableEnded) {
      res.write(chunk);
      this.logger.info(`[请求] 已向客户端发送标准错误信号: ${errorMessage}`);
    }
  }

  _getKeepAliveChunk(req) {
    if (req.path.includes('chat/completions')) {
      const payload = { id: `chatcmpl-${this._generateRequestId()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "gpt-4", choices: [{ index: 0, delta: {}, finish_reason: null }] };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    if (req.path.includes('generateContent') || req.path.includes('streamGenerateContent')) {
      const payload = { candidates: [{ content: { parts: [{ text: "" }], role: "model" }, finishReason: null, index: 0, safetyRatings: [] }] };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    return 'data: {}\n\n';
  }

  async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
    const originalPath = req.path;
    const isStreamRequest = originalPath.includes(':stream');

    const shouldCollectForCache = !isStreamRequest && proxyRequest.method === 'GET';

    this.logger.info(`[请求] 伪流式处理流程启动，路径: "${originalPath}"，判定为: ${isStreamRequest ? '流式请求' : '非流式请求'}。${shouldCollectForCache ? '将收集响应用于缓存。' : ''}`);

    let connectionMaintainer = null;
    let fullResponseData = '';
    let responseStatus = 200;
    const responseHeaders = {};

    if (isStreamRequest) {
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const keepAliveChunk = this._getKeepAliveChunk(req);
      connectionMaintainer = setInterval(() => { if (!res.writableEnded) res.write(keepAliveChunk); }, 2000);
    }

    try {
      let lastMessage, requestFailed = false;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        this.logger.info(`[请求] 请求尝试 #${attempt}/${this.maxRetries}...`);
        this._forwardRequest(proxyRequest);
        
        lastMessage = await messageQueue.dequeue();
        
        if (lastMessage.event_type === 'response_headers') {
            responseStatus = lastMessage.status || 200;
            Object.assign(responseHeaders, lastMessage.headers);
        } else if (lastMessage.event_type === 'error' && lastMessage.status >= 400 && lastMessage.status <= 599) {
            const correctedMessage = this._parseAndCorrectErrorDetails(lastMessage);
            await this._handleRequestFailureAndSwitch(correctedMessage, isStreamRequest ? res : null);

            const errorText = `收到 ${correctedMessage.status} 错误。${attempt < this.maxRetries ? `将在 ${this.retryDelay / 1000}秒后重试...` : '已达到最大重试次数。'}`;
            this.logger.warn(`[请求] ${errorText}`);

            if (isStreamRequest) {
                this._sendErrorChunkToClient(res, errorText);
            }

            if (attempt < this.maxRetries) {
                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                continue;
            }
            requestFailed = true;
        }
        break;
      }

      if (lastMessage.event_type === 'error' || requestFailed) {
        const finalError = this._parseAndCorrectErrorDetails(lastMessage);
        if (!res.headersSent) {
          this._sendErrorResponse(res, finalError.status, `请求失败: ${finalError.message}`);
        } else {
          this._sendErrorChunkToClient(res, `请求最终失败 (状态码: ${finalError.status}): ${finalError.message}`);
        }
        return null;
      }

      if (this.failureCount > 0) {
        this.logger.info(`✅ [认证] 请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`);
        this.fullCycleFailure = false;
        this.startOfFailureCycleIndex = null;
      }
      this.failureCount = 0;

      const dataMessage = await messageQueue.dequeue();
      const endMessage = await messageQueue.dequeue();
      if (endMessage.type !== 'STREAM_END') this.logger.warn('[请求] 未收到预期的流结束信号。');

      if (dataMessage.data) {
          fullResponseData = dataMessage.data;
      }
      
      if (isStreamRequest) {
        if (fullResponseData) {
          res.write(`data: ${fullResponseData}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        this.logger.info('[请求] 已将完整响应作为模拟SSE事件发送。');
      } else {
        this.logger.info('[请求] 准备发送 application/json 响应。');
        if (fullResponseData) {
          try {
            if (!res.headersSent) {
                res.status(responseStatus).set(responseHeaders).json(JSON.parse(fullResponseData));
            }
          } catch (e) {
            this.logger.error(`[请求] 无法将来自浏览器的响应解析为JSON: ${e.message}`);
            this._sendErrorResponse(res, 500, '代理内部错误：无法解析来自后端的响应。');
          }
        } else {
          this._sendErrorResponse(res, 500, '代理内部错误：后端未返回有效数据。');
        }
      }
      
      return { status: responseStatus, headers: responseHeaders, body: fullResponseData };

    } catch (error) {
      this.logger.error(`[请求] 伪流式处理期间发生意外错误: ${error.message}`);
      if (!res.headersSent) {
        this._handleRequestError(error, res);
      } else {
        this._sendErrorChunkToClient(res, `处理失败: ${error.message}`);
      }
      return null;
    } finally {
      if (connectionMaintainer) clearInterval(connectionMaintainer);
      if (!res.writableEnded) res.end();
      this.logger.info('[请求] 伪流式响应处理结束。');
    }
  }

  _generateCacheKey(req) {
    const queryParams = new URLSearchParams(req.query).toString();
    return `cache:${req.method}:${req.path}${queryParams ? '?' + queryParams : ''}`;
  }

  _sendCachedResponse(parsedCache, res) {
      res.status(parsedCache.status || 200).set({
          'Content-Type': 'application/json',
          'X-Proxy-Cache': 'HIT',
          'Cache-Control': `max-age=${this.config.cacheTTL}`
      });
      if (parsedCache.headers) {
          Object.entries(parsedCache.headers).forEach(([name, value]) => {
              if (name.toLowerCase() !== 'content-length' && name.toLowerCase() !== 'transfer-encoding' && name.toLowerCase() !== 'connection') {
                  res.set(name, value);
              }
          });
        }
      res.send(parsedCache.body);
  }
  async clearCache() {
    if (!this.redisClient) {
      this.logger.info('[缓存] 缓存清除被跳过：Redis 未配置。');
      return { success: false, message: 'Redis 未配置，无法清除缓存。' };
    }
    try {
      const keys = await this.redisClient.keys('cache:*');
      if (keys.length > 0) {
        const count = await this.redisClient.del(keys);
        this.logger.info(`[缓存] 成功清除了 ${count} 个缓存条目。`);
        return { success: true, message: `成功清除了 ${count} 个缓存条目。`, count };
      } else {
        this.logger.info('[缓存] 没有找到需要清除的缓存条目。');
        return { success: true, message: '没有找到需要清除的缓存条目。', count: 0 };
      }
    } catch (error) {
      this.logger.error(`[缓存] 清除缓存失败: ${error.message}`);
      return { success: false, message: `清除缓存失败: ${error.message}` };
    }
  }
}

module.exports = RequestHandler;