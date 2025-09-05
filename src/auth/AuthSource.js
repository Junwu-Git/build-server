const fs = require('fs');
const path = require('path');

class AuthSource {
  constructor(logger) {
    this.logger = logger;
    this.authMode = 'file'; // 默认模式
    this.initialIndices = []; // 启动时发现的索引
    this.runtimeAuths = new Map(); // 用于动态添加的账号

    if (process.env.AUTH_JSON_1) {
      this.authMode = 'env';
      this.logger.info('[认证] 检测到 AUTH_JSON_1 环境变量，切换到环境变量认证模式。');
    } else {
      this.logger.info('[认证] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。');
    }

    this._discoverAvailableIndices();

    if (this.getAvailableIndices().length === 0) {
      this.logger.error(`[认证] 致命错误：在 '${this.authMode}' 模式下未找到任何有效的认证源。`);
      throw new Error("未找到有效的认证源。");
    }
  }

  _discoverAvailableIndices() {
    let indices = [];
    if (this.authMode === 'env') {
      const regex = /^AUTH_JSON_(\d+)$/;
      for (const key in process.env) {
        const match = key.match(regex);
        // 修正：正确解析捕获组 (match[1]) 而不是整个匹配对象
        if (match && match[1]) {
          indices.push(parseInt(match[1], 10));
        }
      }
    } else { // 'file' 模式
      const authDir = path.join(__dirname, '..', '..', 'auth'); // Adjusted path
      if (!fs.existsSync(authDir)) {
        this.logger.warn('[认证] "auth/" 目录不存在。');
        this.initialIndices = [];
        return;
      }
      try {
        const files = fs.readdirSync(authDir);
        const authFiles = files.filter(file => /^auth-\d+\.json$/.test(file));
        // 修正：正确解析文件名中的捕获组 (match[1])
        indices = authFiles.map(file => {
          const match = file.match(/^auth-(\d+)\.json$/);
          return parseInt(match[1], 10);
        });
      } catch (error) {
        this.logger.error(`[认证] 扫描 "auth/" 目录失败: ${error.message}`);
        this.initialIndices = [];
        return;
      }
    }
    this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    this.logger.info(`[认证] 在 '${this.authMode}' 模式下，检测到 ${this.initialIndices.length} 个认证源。`);
    if (this.initialIndices.length > 0) {
      this.logger.info(`[认证] 可用初始索引: [${this.initialIndices.join(', ')}]`);
    }
  }

  getAvailableIndices() {
    const runtimeIndices = Array.from(this.runtimeAuths.keys());
    const allIndices = [...new Set([...this.initialIndices, ...runtimeIndices])].sort((a, b) => a - b);
    return allIndices;
  }

  // 新增方法：为仪表盘获取详细信息
  getAccountDetails() {
    const allIndices = this.getAvailableIndices();
    return allIndices.map(index => ({
      index,
      source: this.runtimeAuths.has(index) ? 'temporary' : this.authMode
    }));
  }


  getFirstAvailableIndex() {
    const indices = this.getAvailableIndices();
    return indices.length > 0 ? indices[0] : null;
  }

  getAuth(index) {
    if (!this.getAvailableIndices().includes(index)) {
      this.logger.error(`[认证] 请求了无效或不存在的认证索引: ${index}`);
      return null;
    }

    // 优先使用运行时（临时）的认证信息
    if (this.runtimeAuths.has(index)) {
      this.logger.info(`[认证] 使用索引 ${index} 的临时认证源。`);
      return this.runtimeAuths.get(index);
    }

    let jsonString;
    let sourceDescription;

    if (this.authMode === 'env') {
      jsonString = process.env[`AUTH_JSON_${index}`];
      sourceDescription = `环境变量 AUTH_JSON_${index}`;
    } else {
      const authFilePath = path.join(__dirname, '..', '..', 'auth', `auth-${index}.json`); // Adjusted path
      sourceDescription = `文件 ${authFilePath}`;
      if (!fs.existsSync(authFilePath)) {
        this.logger.error(`[认证] ${sourceDescription} 在读取时突然消失。`);
        return null;
      }
      try {
        jsonString = fs.readFileSync(authFilePath, 'utf-8');
      } catch (e) {
        this.logger.error(`[认证] 读取 ${sourceDescription} 失败: ${e.message}`);
        return null;
      }
    }

    try {
      return JSON.parse(jsonString);
    } catch (e) {
      this.logger.error(`[认证] 解析来自 ${sourceDescription} 的JSON内容失败: ${e.message}`);
      return null;
    }
  }

  // 新增方法：动态添加账号
  addAccount(index, authData) {
    if (typeof index !== 'number' || index <= 0) {
      return { success: false, message: "索引必须是一个正数。" };
    }
    if (this.initialIndices.includes(index)) {
      return { success: false, message: `索引 ${index} 已作为永久账号存在。` };
    }
    try {
      // 验证 authData 是否为有效的JSON对象
      if (typeof authData !== 'object' || authData === null) {
        throw new Error("提供的数据不是一个有效的对象。");
      }
      this.runtimeAuths.set(index, authData);
      this.logger.info(`[认证] 成功添加索引为 ${index} 的临时账号。`);
      return { success: true, message: `账号 ${index} 已临时添加。` };
    } catch (e) {
      this.logger.error(`[认证] 添加临时账号 ${index} 失败: ${e.message}`);
      return { success: false, message: `添加账号失败: ${e.message}` };
    }
  }

  // 新增方法：动态删除账号
  removeAccount(index) {
    if (!this.runtimeAuths.has(index)) {
      return { success: false, message: `索引 ${index} 不是一个临时账号，无法移除。` };
    }
    this.runtimeAuths.delete(index);
    this.logger.info(`[认证] 成功移除索引为 ${index} 的临时账号。`);
    return { success: true, message: `账号 ${index} 已移除。` };
  }
}

module.exports = AuthSource;