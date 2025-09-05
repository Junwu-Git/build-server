class LoggingService {
  constructor(serviceName = 'ProxyServer') {
    this.serviceName = serviceName;
  }

  _getFormattedTime() {
    // 使用 toLocaleTimeString 并指定 en-GB 区域来保证输出为 HH:mm:ss 格式
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  // 用于 ERROR, WARN, DEBUG 等带有级别标签的日志
  _formatMessage(level, message) {
    const time = this._getFormattedTime();
    return `[${level}] ${time} [${this.serviceName}] - ${message}`;
  }

  // info 级别使用特殊格式，不显示 [INFO]
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
    // 修正：移除内部对环境变量的检查。
    // 现在，只要调用此方法，就会打印日志。
    // 是否调用取决于程序其他部分的 this.config.debugMode 判断。
    console.debug(this._formatMessage('DEBUG', message));
  }
}

module.exports = LoggingService;