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
      this.logger.warn('尝试启动一个已在运行的浏览器实例，操作已取消。');
      return;
    }

    const sourceDescription = this.authSource.authMode === 'env' ? `环境变量 AUTH_JSON_${authIndex}` : `文件 auth-${authIndex}.json`;
    this.logger.info('==================================================');
    this.logger.info(`🚀 [浏览器] 准备启动浏览器`);
    this.logger.info(`   • 认证源: ${sourceDescription}`);
    this.logger.info('==================================================');

    const storageStateObject = await this.authSource.getAuth(authIndex);
    if (!storageStateObject) {
      this.logger.error(`❌ [浏览器] 无法获取或解析索引为 ${authIndex} 的认证信息。`);
      throw new Error(`获取或解析索引 ${authIndex} 的认证源失败。`);
    }

    if (storageStateObject.cookies && Array.isArray(storageStateObject.cookies)) {
      let fixedCount = 0;
      const validSameSiteValues = ['Lax', 'Strict', 'None'];
      storageStateObject.cookies.forEach(cookie => {
        if (!validSameSiteValues.includes(cookie.sameSite)) {
          this.logger.warn(`[认证] 发现无效的 sameSite 值: '${cookie.sameSite}'，正在自动修正为 'None'。`);
          cookie.sameSite = 'None';
          fixedCount++;
        }
      });
      if (fixedCount > 0) {
        this.logger.info(`[认证] 自动修正了 ${fixedCount} 个无效的 Cookie 'sameSite' 属性。`);
      }
    }

    let buildScriptContent;
    try {
      const scriptFilePath = path.join(__dirname, '..', this.scriptFileName);
      if (fs.existsSync(scriptFilePath)) {
        buildScriptContent = fs.readFileSync(scriptFilePath, 'utf-8');
        this.logger.info(`✅ [浏览器] 成功读取注入脚本 "${this.scriptFileName}"`);
      } else {
        this.logger.warn(`[浏览器] 未找到注入脚本 "${this.scriptFileName}"。将无注入继续运行。`);
        buildScriptContent = "console.log('dark-browser.js not found, running without injection.');";
      }
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
        this.logger.error('❌ [浏览器] 浏览器意外断开连接！服务器可能需要重启。');
        this.browser = null; this.context = null; this.page = null;
      });
      this.context = await this.browser.newContext({
        storageState: storageStateObject,
        viewport: { width: 1280, height: 720 },
      });

      this.page = await this.context.newPage();
      this.logger.info(`[浏览器] 正在加载账号 ${authIndex} 并访问目标网页...`);
      const targetUrl = this.config.automationTargets.targetUrl;
      const debugFolder = path.resolve(__dirname, '..', 'debug-screenshots');
      if (!fs.existsSync(debugFolder)) {
        fs.mkdirSync(debugFolder, { recursive: true });
      }

      // ======================================================
      // 页面加载带重试 + 失败截图
      // ======================================================
      let pageLoadedSuccessfully = false;
      const maxNavRetries = 3;
      for (let attempt = 1; attempt <= maxNavRetries; attempt++) {
        try {
          this.logger.info(`[浏览器] 页面加载尝试 #${attempt}/${maxNavRetries}...`);
          await this.page.goto(targetUrl, { timeout: 120000, waitUntil: 'networkidle' });

          const internalErrorLocator = this.page.locator('text=An internal error occurred');
          if (await internalErrorLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
            throw new Error('"An internal error occurred"，视为加载失败');
          }

          pageLoadedSuccessfully = true;
          this.logger.info('[浏览器] 网页加载成功，且内容正确。');

          if (this.config.debugMode) {
            const successPath = path.join(debugFolder, `success-load-${authIndex}-${new Date().toISOString().replace(/:/g, '-')}.png`);
            await this.page.screenshot({ path: successPath, fullPage: true });
            this.logger.info(`[调试] 成功加载的页面截图已保存: ${successPath}`);
          }
          break;
        } catch (error) {
          this.logger.warn(`[浏览器] 页面加载尝试 #${attempt} 失败: ${error.message}`);
          if (this.config.debugMode) {
            const errorScreenshotPath = path.join(debugFolder, `failed-nav-${authIndex}-${attempt}-${new Date().toISOString().replace(/:/g, '-')}.png`);
            await this.page.screenshot({ path: errorScreenshotPath, fullPage: true }).catch(() => {});
            this.logger.info(`[调试] 失败截图已保存: ${errorScreenshotPath}`);
          }

          if (attempt < maxNavRetries) {
            this.logger.info('[浏览器] 等待 5 秒后重试...');
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else {
            this.logger.error('❌ 达到最大页面加载重试次数，启动失败。');
            throw error;
          }
        }
      }

      if (!pageLoadedSuccessfully) throw new Error('所有页面加载尝试均失败，无法继续。');

      // ======================================================
      // 【V10 - 终局方案：简单、耐心、重复】
      // ======================================================
      
      this.logger.info('[浏览器] 页面加载完成，无条件等待10秒，确保UI完全稳定...');
      await this.page.waitForTimeout(10000);

      this.logger.info('[浏览器] 开始在15秒内，持续清理所有已知的弹窗...');
      const cleanupTimeout = Date.now() + 15000;
      
      const closeButtonSelectors = this.config.automationTargets.popupCloseButtons || [];
      const combinedSelector = Array.isArray(closeButtonSelectors) ? closeButtonSelectors.join(', ') : "button:has-text('Got it'), button:has-text('✕')";

      if (combinedSelector) {
        while (Date.now() < cleanupTimeout) {
            const buttons = await this.page.locator(combinedSelector).all();
            for (const button of buttons) {
                if (await button.isVisible().catch(() => false)) {
                  await button.click({ force: true, timeout: 1000 }).catch(() => {});
                  this.logger.info(`[浏览器] 关闭了一个弹窗...`);
                }
            }
            await this.page.waitForTimeout(1000);
        }
      }
      this.logger.info('[浏览器] 15秒的持续清理阶段结束。');

      if (this.config.debugMode) {
        this.logger.info('[调试] 所有清理和等待已完成，记录最终页面状态...');
        const finalSnapshotPath = path.join(debugFolder, `FINAL_STATE_before_click-${authIndex}-${new Date().toISOString().replace(/:/g, '-')}.png`);
        await this.page.screenshot({ path: finalSnapshotPath, fullPage: true });
        this.logger.info(`[调试] 最终状态快照已保存: ${finalSnapshotPath}`);
        
        const allButtons = await this.page.locator('button').allTextContents();
        this.logger.info(`[调试] 最终页面按钮列表: ${JSON.stringify(allButtons, null, 2)}`);
      }
      
      try {
        const { role, name, exact } = this.config.automationTargets.codeButtonClick;
        const codeButton = this.page.getByRole(role, { name, exact });
        await codeButton.waitFor({ timeout: 10000 });
        await codeButton.click({ force: true });
        this.logger.info(`[浏览器] 已成功强制点击 "${name}" 按钮。`);
      } catch (err) {
        this.logger.error(`[浏览器] 在所有清理和等待后，点击 "Code" 按钮依然失败，这是致命错误。`, err);
        throw err;
      }
      
      const editorLocator = this.page.locator(this.config.automationTargets.editorSelector).first();
      this.logger.info('[浏览器] 等待编辑器附加到DOM，最长120秒...');
      await editorLocator.waitFor({ state: 'attached', timeout: 120000 });
      this.logger.info('[浏览器] 编辑器已附加。');

      this.logger.info('[浏览器] 等待3秒，之后将在编辑器上执行一次模拟点击以确保其激活...');
      await this.page.waitForTimeout(3000);
      await editorLocator.click({ force: true, timeout: 120000 });

      await this.page.evaluate(text => navigator.clipboard.writeText(text), buildScriptContent);
      const pasteKey = os.platform() === 'darwin' ? 'Meta+V' : 'Control+V';
      await this.page.keyboard.press(pasteKey);
      this.logger.info('[浏览器] 注入脚本已粘贴。');

      const { role: previewRole, name: previewName } = this.config.automationTargets.previewButton;
      await this.page.getByRole(previewRole, { name: previewName }).click();
      this.logger.info(`[浏览器] 已切换到 ${previewName} 视图。`);

      this.currentAuthIndex = authIndex;
      this.logger.info('==================================================');
      this.logger.info(`✅ [浏览器] 账号 ${authIndex} 初始化成功！`);
      this.logger.info('✅ [浏览器] 浏览器客户端已准备就绪。');
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
      this.logger.info('[浏览器] 正在关闭当前浏览器实例...');
      await this.browser.close();
      this.browser = null; this.context = null; this.page = null;
      this.logger.info('[浏览器] 浏览器已关闭。');
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(`🔄 [浏览器] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`);
    await this.closeBrowser();
    await this.launchBrowser(newAuthIndex);
    this.logger.info(`✅ [浏览器] 账号切换完成，当前账号: ${this.currentAuthIndex}`);
  }

  async takeScreenshot(failureType) {
    if (!this.config.debugMode) {
      return;
    }

    if (!this.page) {
      this.logger.warn('[调试] 无法截图，因为页面对象 (page) 不存在。');
      return;
    }

    try {
      const debugFolder = path.resolve(__dirname, '..', 'debug-screenshots');
      if (!fs.existsSync(debugFolder)) {
        fs.mkdirSync(debugFolder, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const screenshotPath = path.join(debugFolder, `failure-${failureType}-${timestamp}.png`);
      
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      this.logger.info(`[调试] 屏幕截图已保存: ${screenshotPath}`);
    } catch (error) {
      this.logger.error(`[调试] 无法捕获屏幕截图: ${error.message}`);
    }
  }
}

module.exports = BrowserManager;