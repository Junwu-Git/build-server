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

    if (this.config.browserExecutablePath) {
      this.browserExecutablePath = this.config.browserExecutablePath;
      this.logger.info(`[系统] 使用环境变量 CAMOUFOX_EXECUTABLE_PATH 指定的浏览器路径。`);
    } else {
      const platform = os.platform();
      if (platform === 'win32') {
        this.browserExecutablePath = path.join(__dirname, '..', '..', 'camoufox', 'camoufox.exe');
        this.logger.info(`[系统] 检测到操作系统: Windows. 将使用 'camoufox' 目录下的浏览器。`);
      } else if (platform === 'linux') {
        this.browserExecutablePath = path.join(__dirname, '..', '..', 'camoufox-linux', 'camoufox');
        this.logger.info(`[系统] 检测到操作系统: Linux. 将使用 'camoufox-linux' 目录下的浏览器。`);
      } else {
        this.logger.error(`[系统] 不支持的操作系统: ${platform}.`);
        throw new Error(`不支持的操作系统: ${platform}`);
      }
    }
  }

  _onDisconnected() {
    this.logger.error('❌ [浏览器] 浏览器意外断开连接！服务器可能需要重启。');
    this.browser = null;
    this.context = null;
    this.page = null;
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
    this.logger.info(`   • 浏览器路径: ${this.browserExecutablePath}`);
    this.logger.info('==================================================');

    if (!fs.existsSync(this.browserExecutablePath)) {
      this.logger.error(`❌ [浏览器] 找不到浏览器可执行文件: ${this.browserExecutablePath}`);
      throw new Error(`找不到浏览器可执行文件路径: ${this.browserExecutablePath}`);
    }

    const storageStateObject = this.authSource.getAuth(authIndex);
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
      const scriptFilePath = path.join(__dirname, '..', '..', this.scriptFileName);
      if (fs.existsSync(scriptFilePath)) {
        buildScriptContent = fs.readFileSync(scriptFilePath, 'utf-8');
        this.logger.info(`✅ [浏览器] 成功读取注入脚本 "${this.scriptFileName}"`);
      } else {
        this.logger.warn(`[浏览器] 未找到注入脚本 "${this.scriptFileName}"。将无注入继续运行。`);
        buildScriptContent = "console.log('dark-browser.js not found, running without injection.');";
      }
    } catch (error) {
      this.logger.error(`❌ [浏览器] 无法读取注入脚本 "${this.scriptFileName}"！`);
      throw error;
    }

    try {
      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
      });
      this.browser.on('disconnected', this._onDisconnected.bind(this));
      this.context = await this.browser.newContext({
        storageState: storageStateObject,
        viewport: { width: 1280, height: 720 },
      });

      this.page = await this.context.newPage();
      this.logger.info(`[浏览器] 正在加载账号 ${authIndex} 并访问目标网页...`);
      const targetUrl = this.config.targetUrl;
      const debugFolder = path.resolve(__dirname, '..', '..', 'debug-screenshots');
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

          // 成功截图
          const successPath = path.join(debugFolder, `success-load-${authIndex}-${Date.now()}.png`);
          await this.page.screenshot({ path: successPath, fullPage: true });
          this.logger.info(`[调试] 成功加载的页面截图已保存: ${successPath}`);
          break;
        } catch (error) {
          this.logger.warn(`[浏览器] 页面加载尝试 #${attempt} 失败: ${error.message}`);
          const errorScreenshotPath = path.join(debugFolder, `failed-nav-${authIndex}-${attempt}-${Date.now()}.png`);
          await this.page.screenshot({ path: errorScreenshotPath, fullPage: true }).catch(() => {});
          this.logger.info(`[浏览器] 失败截图已保存: ${errorScreenshotPath}`);

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
      
      // 第一步：给予页面充足的“静默”稳定时间
      // 不做任何检查，只是简单地、无条件地等待10秒。
      // 这足以让99%的前端动画和异步加载完成。
      this.logger.info('[浏览器] 页面加载完成，无条件等待10秒，确保UI完全稳定...');
      await this.page.waitForTimeout(10000);

      // 第二步：在一个固定时间内，持续不断地“清扫”页面
      // 这是一个“愚蠢”但极其有效的循环，它会反复尝试关闭所有已知的弹窗。
      this.logger.info('[浏览器] 开始在15秒内，持续清理所有弹窗...');
      const cleanupTimeout = Date.now() + 15000;
      let closedCount = 0;
      
      // 定义所有可能的关闭按钮
      const closeButtonLocator = this.page.locator(
        "button:has-text('Got it'), button:has-text('✕')"
      );

      while (Date.now() < cleanupTimeout) {
        // 尝试找到并点击所有可见的关闭按钮，忽略任何错误
        const buttons = await closeButtonLocator.all();
        for (const button of buttons) {
          await button.click({ force: true }).catch(() => {});
          closedCount++;
          this.logger.info(`[浏览器] 关闭了一个弹窗... (已尝试关闭 ${closedCount} 个)`);
        }
        // 每次清扫后，等待一小段时间
        await this.page.waitForTimeout(1000);
      }
      this.logger.info('[浏览器] 15秒的持续清理阶段结束。');

      // 第三步：最终的调试与核心操作
      this.logger.info('[调试] 所有清理和等待已完成，记录最终页面状态...');
      const finalSnapshotPath = path.join(debugFolder, `FINAL_STATE_before_click.png`);
      await this.page.screenshot({ path: finalSnapshotPath, fullPage: true });
      this.logger.info(`[调试] 最终状态快照已保存: ${finalSnapshotPath}`);
      
      const allButtons = await this.page.locator('button').allTextContents();
      this.logger.info(`[调试] 最终页面按钮列表: ${JSON.stringify(allButtons, null, 2)}`);

      // 第四步：执行最终的、带有“双保险”的核心点击
      try {
        const codeButton = this.page.getByRole('button', { name: 'Code' });
        // 双保险：先等待按钮出现，再用 force 点击
        await codeButton.waitFor({ timeout: 10000 });
        await codeButton.click({ force: true });
        this.logger.info('[浏览器] 已成功强制点击 "Code" 按钮。');
      } catch (err) {
        this.logger.error('[浏览器] 在所有清理和等待后，点击 "Code" 按钮依然失败，这是致命错误。', err);
        throw err;
      }
      
      // 后续的注入脚本逻辑
      const editorContainerLocator = this.page.locator('div.monaco-editor').first();
                        
      this.logger.info('[浏览器] 等待编辑器附加到DOM，最长120秒...');
      await editorContainerLocator.waitFor({ state: 'attached', timeout: 120000 });
      this.logger.info('[浏览器] 编辑器已附加。');

      this.logger.info('[浏览器] 等待5秒，之后将在页面下方执行一次模拟点击以确保页面激活...');
      await this.page.waitForTimeout(5000);

      const viewport = this.page.viewportSize();
      if (viewport) {
        const clickX = viewport.width / 2;
        const clickY = viewport.height - 120;
        this.logger.info(`[浏览器] 在页面底部中心位置 (x≈${Math.round(clickX)}, y=${clickY}) 执行点击。`);
        await this.page.mouse.click(clickX, clickY);
      } else {
        this.logger.warn('[浏览器] 无法获取视窗大小，跳过页面底部模拟点击。');
      }

      await editorContainerLocator.click({ force: true, timeout: 120000 });
      await this.page.evaluate(text => navigator.clipboard.writeText(text), buildScriptContent);
      const isMac = os.platform() === 'darwin';
      const pasteKey = isMac ? 'Meta+V' : 'Control+V';
      await this.page.keyboard.press(pasteKey);
      this.logger.info('[浏览器] 脚本已粘贴。');

      this.logger.info('[浏览器] 正在点击 "Preview" 按钮以使代码生效...');
      await this.page.getByRole('button', { name: 'Preview' }).click();
      this.logger.info('[浏览器] 已切换到预览视图。浏览器端初始化完成。');


      this.currentAuthIndex = authIndex;
      this.logger.info('==================================================');
      this.logger.info(`✅ [浏览器] 账号 ${authIndex} 初始化成功！`);
      this.logger.info('✅ [浏览器] 浏览器客户端已准备就绪。');
      this.logger.info('==================================================');
    } catch (error) {
      this.logger.error(`❌ [浏览器] 账号 ${authIndex} 初始化失败: ${error.message}`);
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info('正在为账号切换关闭浏览器，跳过全局停机标志。');
      this.browser.removeListener('disconnected', this._onDisconnected.bind(this));
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.logger.info('[浏览器] 浏览器实例已成功关闭。');
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(`🔄 [浏览器] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`);
    await this.closeBrowser();
    await this.launchBrowser(newAuthIndex);
    this.logger.info(`✅ [浏览器] 账号切换完成，当前账号: ${this.currentAuthIndex}`);
  }
}

module.exports = BrowserManager;