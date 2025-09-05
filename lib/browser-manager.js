const fs = require('fs');
const path = require('path');
const os = require('os');
const { firefox } = require('playwright');

class BrowserManager {
  constructor(logger, config, authSource) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = 'dark-browser.js';

    this.logger.info('[系统] BrowserManager 已初始化，将使用 Playwright 自动管理的浏览器。');
  }

  async launchBrowser(authIndex) {
    if (this.browser) {
      this.logger.warn('浏览器实例已在运行，取消重复启动。');
      return;
    }

    this.logger.info(`🚀 [浏览器] 正在为账号索引 ${authIndex} 启动浏览器...`);

    const storageStateObject = await this.authSource.getAuth(authIndex);
    if (!storageStateObject) {
      this.logger.error(`❌ [浏览器] 无法获取索引为 ${authIndex} 的认证信息。`);
      throw new Error(`获取认证信息失败: index ${authIndex}`);
    }

    // 自动修正无效的 sameSite cookie 属性
    if (storageStateObject.cookies && Array.isArray(storageStateObject.cookies)) {
      const validSameSiteValues = ['Lax', 'Strict', 'None'];
      storageStateObject.cookies.forEach(cookie => {
        if (!validSameSiteValues.includes(cookie.sameSite)) {
          cookie.sameSite = 'None';
        }
      });
    }

    let buildScriptContent;
    try {
      const scriptFilePath = path.join(__dirname, '..', this.scriptFileName);
      buildScriptContent = fs.readFileSync(scriptFilePath, 'utf-8');
      this.logger.info(`✅ [浏览器] 成功读取注入脚本: "${this.scriptFileName}"`);
    } catch (error) {
      this.logger.error(`❌ [浏览器] 无法读取注入脚本 "${this.scriptFileName}"！`, error);
      throw error;
    }

    try {
      this.browser = await firefox.launch({
        headless: true,
        args: ['--disable-gpu', '--no-sandbox'],
      });

      this.browser.on('disconnected', () => {
        this.logger.error('❌ [浏览器] 浏览器意外断开连接！');
        this.browser = null;
        this.context = null;
        this.page = null;
      });

      this.context = await this.browser.newContext({
        storageState: storageStateObject,
        viewport: { width: 1280, height: 720 },
      });

      this.page = await this.context.newPage();
      const targetUrl = this.config.automationTargets.targetUrl;
      
      this.logger.info(`[浏览器] 正在加载页面: ${targetUrl}`);
      await this.page.goto(targetUrl, { timeout: 120000, waitUntil: 'networkidle' });
      this.logger.info('[浏览器] 页面加载成功。');

      // 等待并清理弹窗
      this.logger.info('[浏览器] 开始清理弹窗...');
      const cleanupTimeout = Date.now() + 15000;
      const closeButtonSelectors = this.config.automationTargets.popupCloseButtons || [];
      const combinedSelector = Array.isArray(closeButtonSelectors) ? closeButtonSelectors.join(', ') : '';
      
      if (combinedSelector) {
        while (Date.now() < cleanupTimeout) {
            const buttons = await this.page.locator(combinedSelector).all();
            for (const button of buttons) {
                await button.click({ force: true, timeout: 1000 }).catch(() => {});
            }
            await this.page.waitForTimeout(500);
        }
      }
      this.logger.info('[浏览器] 弹窗清理阶段完成。');

      // 点击核心按钮
      const { role, name, exact } = this.config.automationTargets.codeButtonClick;
      const codeButton = this.page.getByRole(role, { name, exact });
      await codeButton.click({ force: true });
      this.logger.info(`[浏览器] 已点击 "${name}" 按钮。`);

      // 等待编辑器并注入脚本
      const editorLocator = this.page.locator(this.config.automationTargets.editorSelector).first();
      await editorLocator.waitFor({ state: 'attached', timeout: 120000 });
      this.logger.info('[浏览器] 编辑器已加载。');
      
      await editorLocator.click({ force: true });
      await this.page.evaluate(text => navigator.clipboard.writeText(text), buildScriptContent);
      const pasteKey = os.platform() === 'darwin' ? 'Meta+V' : 'Control+V';
      await this.page.keyboard.press(pasteKey);
      this.logger.info('[浏览器] 注入脚本已粘贴。');

      // 点击预览按钮
      const { role: previewRole, name: previewName } = this.config.automationTargets.previewButton;
      await this.page.getByRole(previewRole, { name: previewName }).click();
      this.logger.info(`[浏览器] 已切换到 ${previewName} 视图。`);

      this.currentAuthIndex = authIndex;
      this.logger.info('==================================================');
      this.logger.info(`✅ [浏览器] 账号 ${authIndex} 初始化成功！客户端已就绪。`);
      this.logger.info('==================================================');

    } catch (error) {
      this.logger.error(`❌ [浏览器] 账号 ${authIndex} 初始化失败: ${error.message}`, error);
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info('[浏览器] 正在关闭浏览器实例...');
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.logger.info('[浏览器] 浏览器已关闭。');
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(`🔄 [浏览器] 正在切换账号: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`);
    await this.closeBrowser();
    await this.launchBrowser(newAuthIndex);
    this.logger.info(`✅ [浏览器] 账号切换完成，当前为: ${this.currentAuthIndex}`);
  }
}

module.exports = BrowserManager;