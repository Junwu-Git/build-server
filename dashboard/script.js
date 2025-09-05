document.addEventListener('DOMContentLoaded', () => {
    const API_KEY_SESSION_STORAGE = 'dashboard_api_key';
    const API_BASE = '/dashboard';

    // DOM Elements
    const mainContainer = document.querySelector('main.container');
    const uptimeEl = document.getElementById('uptime');
    const debugModeEl = document.getElementById('debugMode');
    const browserConnectedEl = document.getElementById('browserConnected');
    const authModeEl = document.getElementById('authMode');
    const apiKeyAuthEl = document.getElementById('apiKeyAuth');
    const totalCallsEl = document.getElementById('totalCalls');
    const accountCallsEl = document.getElementById('accountCalls');
    const accountPoolEl = document.getElementById('accountPool');
    const switchAccountBtn = document.getElementById('switchAccountBtn');
    const addAccountBtn = document.getElementById('addAccountBtn');
    const configForm = document.getElementById('configForm');
    const toastEl = document.getElementById('toast');

    function getAuthHeaders(hasBody = false) {
        const headers = {
            'X-Dashboard-Auth': sessionStorage.getItem(API_KEY_SESSION_STORAGE) || ''
        };
        if (hasBody) {
            headers['Content-Type'] = 'application/json';
        }
        return headers;
    }

    function showToast(message, isError = false) {
        toastEl.textContent = message;
        toastEl.className = isError ? 'toast show error' : 'toast show';
        setTimeout(() => { toastEl.className = 'toast'; }, 3000);
    }

    function formatUptime(seconds) {
        const d = Math.floor(seconds / (3600*24));
        const h = Math.floor(seconds % (3600*24) / 3600);
        const m = Math.floor(seconds % 3600 / 60);
        const s = Math.floor(seconds % 60);
        return `${d}天 ${h}小时 ${m}分钟 ${s}秒`;
    }

    function handleAuthFailure() {
        sessionStorage.removeItem(API_KEY_SESSION_STORAGE);
        mainContainer.style.display = 'none';
        document.body.insertAdjacentHTML('afterbegin', '<h1>认证已过期或无效，请刷新页面重试。</h1>');
        showToast('认证失败', true);
    }

    async function fetchData() {
        try {
            const response = await fetch(`${API_BASE}/data`, { headers: getAuthHeaders() });
            if (response.status === 401) return handleAuthFailure();
            if (!response.ok) throw new Error('获取数据失败');
            const data = await response.json();
            
            uptimeEl.textContent = formatUptime(data.status.uptime);
            browserConnectedEl.innerHTML = data.status.browserConnected ? '<span class="status-text-info">已连接</span>' : '<span class="status-text-red">已断开</span>';
            authModeEl.innerHTML = data.status.authMode === 'env' ? '<span class="status-text-info">环境变量</span>' : '<span class="status-text-info">Cookie文件</span>';
            apiKeyAuthEl.innerHTML = data.status.apiKeyAuth === '已启用' ? '<span class="status-text-info">已启用</span>' : '<span class="status-text-gray">已禁用</span>';
            debugModeEl.innerHTML = data.status.debugMode ? '<span class="status-text-yellow">已启用</span>' : '<span class="status-text-gray">已禁用</span>';
            totalCallsEl.textContent = data.stats.totalCalls;
            
            accountCallsEl.innerHTML = '';
            const sortedAccounts = Object.entries(data.stats.accountCalls).sort((a, b) => parseInt(a) - parseInt(b));
            const callsUl = document.createElement('ul');
            callsUl.className = 'account-list';
            for (const [index, stats] of sortedAccounts) {
                const li = document.createElement('li');
                const isCurrent = parseInt(index, 10) === data.auth.currentAuthIndex;
                let modelStatsHtml = '<ul class="model-stats-list">';
                const sortedModels = Object.entries(stats.models).sort((a, b) => b - a);
                sortedModels.length > 0 ? sortedModels.forEach(([model, count]) => { modelStatsHtml += `<li><span>${model}:</span> <strong>${count}</strong></li>`; }) : modelStatsHtml += '<li>无模型调用记录</li>';
                modelStatsHtml += '</ul>';
                li.innerHTML = `<details><summary><span class="${isCurrent ? 'current' : ''}">账号 ${index}</span><strong>总计: ${stats.total}</strong></summary>${modelStatsHtml}</details>`;
                if(isCurrent) { li.querySelector('summary').style.color = 'var(--pico-primary)'; }
                callsUl.appendChild(li);
            }
            accountCallsEl.appendChild(callsUl);

            accountPoolEl.innerHTML = '';
            const poolUl = document.createElement('ul');
            poolUl.className = 'account-list';
            data.auth.accounts.forEach(acc => {
                const li = document.createElement('li');
                const isCurrent = acc.index === data.auth.currentAuthIndex;
                const sourceTag = acc.source === 'temporary' ? '<span class="tag tag-yellow">临时</span>' : (acc.source === 'env' ? '<span class="tag tag-info">变量</span>' : '<span class="tag tag-blue">文件</span>');
                let html = `<span class="${isCurrent ? 'current' : ''}">账号 ${acc.index} ${sourceTag}</span>`;
                if (acc.source === 'temporary') { html += `<button class="btn-danger btn-sm" data-index="${acc.index}">删除</button>`; } else { html += '<span></span>'; }
                li.innerHTML = html;
                poolUl.appendChild(li);
            });
            accountPoolEl.appendChild(poolUl);
            
            const streamingModeInput = document.querySelector(`input[name="streamingMode"][value="${data.config.streamingMode}"]`);
            if(streamingModeInput) streamingModeInput.checked = true;
            configForm.failureThreshold.value = data.config.failureThreshold;
            configForm.maxRetries.value = data.config.maxRetries;
            configForm.retryDelay.value = data.config.retryDelay;
            configForm.immediateSwitchStatusCodes.value = data.config.immediateSwitchStatusCodes.join(', ');
        } catch (error) {
            console.error('获取数据时出错:', error);
            showToast(error.message, true);
        }
    }

    function initializeDashboardListeners() {
        switchAccountBtn.addEventListener('click', async () => {
            switchAccountBtn.disabled = true;
            switchAccountBtn.textContent = '切换中...';
            try {
                const response = await fetch('/switch', { method: 'POST', headers: getAuthHeaders() });
                const text = await response.text();
                if (!response.ok) throw new Error(text);
                showToast(text);
                await fetchData();
            } catch (error) {
                showToast(error.message, true);
            } finally {
                switchAccountBtn.disabled = false;
                switchAccountBtn.textContent = '切换到下一个账号';
            }
        });
    
        addAccountBtn.addEventListener('click', () => {
            const index = prompt("为新的临时账号输入一个唯一的数字索引：");
            if (!index || isNaN(parseInt(index))) { if(index !== null) alert("索引无效。"); return; }
            const authDataStr = prompt("请输入单行压缩后的Cookie内容:");
            if (!authDataStr) return;
            let authData;
            try { authData = JSON.parse(authDataStr); } catch(e) { alert("Cookie JSON格式无效。"); return; }
            
            fetch(`${API_BASE}/accounts`, { method: 'POST', headers: getAuthHeaders(true), body: JSON.stringify({ index: parseInt(index), authData }) })
                .then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ok, data}) => {
                if (!ok) throw new Error(data.message);
                showToast(data.message); fetchData(); }).catch(err => showToast(err.message, true));
        });
    
        accountPoolEl.addEventListener('click', e => {
            if (e.target.matches('button.btn-danger')) {
                const index = e.target.dataset.index;
                if (confirm(`您确定要删除临时账号 ${index} 吗？`)) {
                    fetch(`${API_BASE}/accounts/${index}`, { method: 'DELETE', headers: getAuthHeaders() })
                        .then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ok, data}) => {
                        if (!ok) throw new Error(data.message);
                        showToast(data.message); fetchData(); }).catch(err => showToast(err.message, true));
                }
            }
        });

        configForm.addEventListener('submit', e => {
            e.preventDefault();
            const formData = new FormData(configForm);
            const data = Object.fromEntries(formData.entries());
            data.immediateSwitchStatusCodes = data.immediateSwitchStatusCodes.split(',').map(s => s.trim()).filter(Boolean);
            fetch(`${API_BASE}/config`, { method: 'POST', headers: getAuthHeaders(true), body: JSON.stringify(data) })
                .then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ok, data}) => {
                if (!ok) throw new Error(data.message);
                showToast('配置已应用。'); fetchData(); }).catch(err => showToast(err.message, true));
        });

        configForm.addEventListener('change', e => {
            if (e.target.name === 'streamingMode') {
                fetch(`${API_BASE}/config`, { method: 'POST', headers: getAuthHeaders(true), body: JSON.stringify({ streamingMode: e.target.value }) })
                    .then(res => res.json().then(d => ({ ok: res.ok, data: d }))).then(({ok, data}) => {
                    if (!ok) throw new Error(data.message);
                    showToast(`流式模式已更新为: ${e.target.value.charAt(0).toUpperCase() + e.target.value.slice(1)}`);
                    }).catch(err => showToast(err.message, true));
            }
        });
    }

    async function verifyAndLoad(keyToVerify) {
        try {
            const response = await fetch(`${API_BASE}/verify-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: keyToVerify || '' })
            });
            const result = await response.json();
            
            if (response.ok && result.success) {
                if (keyToVerify) {
                   sessionStorage.setItem(API_KEY_SESSION_STORAGE, keyToVerify);
                }
                mainContainer.style.display = 'block';
                initializeDashboardListeners();
                fetchData();
                setInterval(fetchData, 5000);
                return true;
            } else {
                sessionStorage.removeItem(API_KEY_SESSION_STORAGE);
                return false;
            }
        } catch (err) {
            document.body.innerHTML = `<h1>认证时发生错误: ${err.message}</h1>`;
            return false;
        }
    }

    async function checkAndInitiate() {
        const storedApiKey = sessionStorage.getItem(API_KEY_SESSION_STORAGE);
        
        // 尝试使用已存储的密钥或空密钥进行验证
        const initialCheckSuccess = await verifyAndLoad(storedApiKey);

        // 如果初次验证失败，说明服务器需要密钥，而我们没有提供或提供了错误的密钥
        if (!initialCheckSuccess) {
            const newApiKey = prompt("请输入API密钥以访问仪表盘 (服务器需要认证):");
            if (newApiKey) {
                // 使用用户新输入的密钥再次尝试
                const secondCheckSuccess = await verifyAndLoad(newApiKey);
                if (!secondCheckSuccess) {
                   document.body.innerHTML = `<h1>认证失败: 无效的API密钥</h1>`;
                }
            } else {
                // 用户取消了输入
                document.body.innerHTML = '<h1>访问被拒绝</h1>';
            }
        }
    }
    
    checkAndInitiate();
});