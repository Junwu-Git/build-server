const { EventEmitter } = require('events');

// ===================================================================================
// 日志服务
// ===================================================================================

class LoggingService {
  constructor(serviceName = 'ProxyServer') {
    this.serviceName = serviceName;
  }

  _getFormattedTime() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  _formatMessage(level, message) {
    const time = this._getFormattedTime();
    return `[${level}] ${time} [${this.serviceName}] - ${message}`;
  }

  info(message) {
    const time = this._getFormattedTime();
    console.log(`${time} [${this.serviceName}] - ${message}`);
  }

  error(message) {
    console.error(this._formatMessage('ERROR', message));
  }

  warn(message) {
    console.warn(this._formatMessage('WARN', message));
  }

  debug(message) {
    console.debug(this._formatMessage('DEBUG', message));
  }
}

// ===================================================================================
// 消息队列
// ===================================================================================

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 1200000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }
  enqueue(message) {
    if (this.closed) return;
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error('队列已关闭');
    }
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error('队列超时'));
        }
      }, timeoutMs);
      resolver.timeoutId = timeoutId;
    });
  }
  close() {
    this.closed = true;
    this.waitingResolvers.forEach(resolver => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error('队列已关闭'));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

// ===================================================================================
// 连接注册表
// ===================================================================================

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
  }
  addConnection(websocket, clientInfo) {
    this.connections.add(websocket);
    this.logger.info(`[服务器] 内部WebSocket客户端已连接 (来自: ${clientInfo.address})`);
    websocket.on('message', (data) => this._handleIncomingMessage(data.toString()));
    websocket.on('close', () => this._removeConnection(websocket));
    websocket.on('error', (error) => this.logger.error(`[服务器] 内部WebSocket连接错误: ${error.message}`));
    this.emit('connectionAdded', websocket);
  }
  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn('[服务器] 内部WebSocket客户端连接断开');
    const errorMessage = {
      event_type: 'error',
      message: 'Browser connection lost',
      status: 503
    };
    this.messageQueues.forEach(queue => queue.enqueue(errorMessage));
    this.emit('connectionRemoved', websocket);
  }
  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      if (!requestId) {
        this.logger.warn('[服务器] 收到无效消息：缺少request_id');
        return;
      }
      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      }
    } catch {
      this.logger.error('[服务器] 解析内部WebSocket消息失败');
    }
  }
  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case 'response_headers': case 'chunk': case 'error':
        queue.enqueue(message);
        break;
      case 'stream_close':
        queue.enqueue({ type: 'STREAM_END' });
        break;
      default:
        this.logger.warn(`[服务器] 未知的内部事件类型: ${event_type}`);
    }
  }
  hasActiveConnections() { return this.connections.size > 0; }
  getFirstConnection() { return this.connections.values().next().value; }
  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }

  shutdown() {
    this.logger.info('[服务器] 开始关闭所有内部WebSocket连接...');
    this.connections.forEach(ws => {
      // 1000 表示正常关闭
      ws.close(1000, '服务器正在关闭');
    });
    this.connections.clear();
    this.logger.info('[服务器] 所有内部WebSocket连接已关闭。');
  }
}

module.exports = {
    LoggingService,
    MessageQueue,
    ConnectionRegistry
};