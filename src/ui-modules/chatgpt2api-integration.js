import { existsSync, readFileSync } from 'fs';
import logger from '../utils/logger.js';
import { getRequestBody, generateUUID } from '../utils/common.js';
import { broadcastEvent } from './event-broadcast.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { normalizeProviderConfigFields } from '../utils/provider-config-normalizer.js';

/**
 * ChatGPT2API 账号池集成模块
 * 
 * 功能：
 * 1. 从 ChatGPT2API 账号池导入账号到 AIClient2API 提供商池
 * 2. 数据格式转换：ChatGPT2API 账号格式 -> AIClient2API 提供商配置
 * 3. 批量导入和管理
 * 4. 双向同步支持
 */

// ChatGPT2API 账号数据结构示例:
// {
//   "access_token": "eyJ0eXAiOi...",
//   "refresh_token": "v1:12345...",
//   "id_token": "eyJra...",
//   "email": "user@example.com",
//   "password": "password123",
//   "type": "free/Plus/Pro/Enterprise",
//   "source_type": "web/oauth_login/password",
//   "quota": 100,
//   "status": "正常/禁用/限流/异常",
//   "user_id": "user-xxx",
//   "proxy": "http://proxy:port",
//   "created_at": "2024-01-01T00:00:00Z",
//   "last_used_at": "2024-01-01T00:00:00Z",
//   "last_token_refresh_at": "2024-01-01T00:00:00Z"
// }

/**
 * 将 ChatGPT2API 账号转换为 AIClient2API 提供商配置
 * @param {Object} chatgptAccount - ChatGPT2API 账号对象
 * @param {string} providerType - 目标提供商类型 (openai-custom, codex-import, etc.)
 * @returns {Object} AIClient2API 提供商配置
 */
export function convertChatGPTAccountToProvider(chatgptAccount, providerType = 'openai-custom') {
    if (!chatgptAccount || !chatgptAccount.access_token) {
        throw new Error('Invalid ChatGPT2API account: missing access_token');
    }

    const accountType = chatgptAccount.type || 'unknown';
    const customName = chatgptAccount.email 
        ? `${chatgptAccount.email} (${accountType})` 
        : `ChatGPT Account (${accountType})`;

    // 根据账号类型确定模型列表
    let supportedModels = [];
    switch (accountType.toLowerCase()) {
        case 'pro':
        case 'enterprise':
            supportedModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
            break;
        case 'plus':
            supportedModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo'];
            break;
        case 'free':
        default:
            supportedModels = ['gpt-4o-mini', 'gpt-3.5-turbo'];
            break;
    }

    const providerConfig = {
        uuid: generateUUID(),
        customName: customName,
        isHealthy: chatgptAccount.status === '正常',
        isDisabled: chatgptAccount.status === '禁用' || chatgptAccount.status === '异常',
        needsRefresh: false,
        lastUsed: chatgptAccount.last_used_at || null,
        usageCount: 0,
        errorCount: 0,
        lastErrorTime: null,
        lastErrorMessage: null,
        
        // OpenAI 特定配置
        OPENAI_API_KEY: chatgptAccount.access_token,
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        
        // OAuth 相关（如果有）
        OPENAI_OAUTH_REFRESH_TOKEN: chatgptAccount.refresh_token || '',
        OPENAI_OAUTH_ID_TOKEN: chatgptAccount.id_token || '',
        
        // 账号元数据
        accountType: accountType,
        sourceType: chatgptAccount.source_type || '',
        email: chatgptAccount.email || '',
        userId: chatgptAccount.user_id || '',
        quota: chatgptAccount.quota || 0,
        proxy: chatgptAccount.proxy || '',
        
        // 模型支持
        supportedModels: supportedModels,
        notSupportedModels: [],
        
        // 刷新和健康检查相关
        lastTokenRefreshAt: chatgptAccount.last_token_refresh_at || null,
        createdAt: chatgptAccount.created_at || null,
        
        // ChatGPT2API 原始数据引用（用于同步）
        chatgpt2apiAccountId: chatgptAccount.access_token.substring(0, 50),
        isChatGPT2APISynced: true
    };

    return normalizeProviderConfigFields(providerConfig);
}

/**
 * 加载 ChatGPT2API 账号池数据
 * @param {string} accountsFilePath - ChatGPT2API accounts.json 文件路径
 * @returns {Array} 账号列表
 */
export function loadChatGPT2APIAccounts(accountsFilePath) {
    if (!existsSync(accountsFilePath)) {
        throw new Error(`ChatGPT2API accounts file not found: ${accountsFilePath}`);
    }

    try {
        const content = readFileSync(accountsFilePath, 'utf-8');
        const data = JSON.parse(content);
        
        // ChatGPT2API 可能存储为对象（key 是 access_token）或数组
        if (Array.isArray(data)) {
            return data;
        } else if (typeof data === 'object' && data !== null) {
            return Object.values(data);
        }
        return [];
    } catch (error) {
        logger.error('[ChatGPT2API Integration] Failed to load accounts:', error.message);
        throw new Error(`Failed to load ChatGPT2API accounts: ${error.message}`);
    }
}

/**
 * 从 ChatGPT2API 获取账号列表（通过 HTTP API）
 * @param {string} apiUrl - ChatGPT2API API 地址
 * @param {string} apiKey - API 密钥
 * @returns {Promise<Array>} 账号列表
 */
export async function fetchChatGPT2APIAccountsFromAPI(apiUrl, apiKey) {
    try {
        const url = `${apiUrl.replace(/\/$/, '')}/api/accounts`;
        const headers = {
            'Content-Type': 'application/json'
        };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data.items || data.accounts || [];
    } catch (error) {
        logger.error('[ChatGPT2API Integration] Failed to fetch accounts from API:', error.message);
        throw error;
    }
}

/**
 * 批量导入 ChatGPT2API 账号到提供商池
 * @param {Object} req - HTTP 请求
 * @param {Object} res - HTTP 响应
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 */
export async function handleImportChatGPT2APIAccounts(req, res, currentConfig, providerPoolManager) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleImportChatGPT2APIAccounts(req, res, currentConfig, providerPoolManager)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}

async function _handleImportChatGPT2APIAccounts(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { 
            source = 'file', 
            filePath: accountsFilePath,
            apiUrl,
            apiKey,
            providerType = 'openai-custom',
            filterStatus = null,
            filterType = null,
            skipExisting = true
        } = body;

        if (source === 'file' && !accountsFilePath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'accountsFilePath is required for file source' } }));
            return true;
        }

        if (source === 'api' && !apiUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'apiUrl is required for api source' } }));
            return true;
        }

        // 获取账号列表
        let accounts = [];
        if (source === 'file') {
            accounts = loadChatGPT2APIAccounts(accountsFilePath);
        } else if (source === 'api') {
            accounts = await fetchChatGPT2APIAccountsFromAPI(apiUrl, apiKey);
        }

        // 应用过滤
        if (filterStatus) {
            accounts = accounts.filter(a => a.status === filterStatus);
        }
        if (filterType) {
            accounts = accounts.filter(a => a.type && a.type.toLowerCase() === filterType.toLowerCase());
        }

        if (accounts.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No accounts to import',
                importedCount: 0,
                skippedCount: 0,
                totalCount: 0
            }));
            return true;
        }

        // 加载现有提供商池
        const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        if (existsSync(poolsFilePath)) {
            try {
                const fileContent = readFileSync(poolsFilePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                logger.warn('[ChatGPT2API Integration] Failed to read provider pools:', readError.message);
            }
        }

        // 确保目标提供商类型存在
        if (!providerPools[providerType]) {
            providerPools[providerType] = [];
        }

        const existingProviders = providerPools[providerType];
        const importedAccounts = [];
        const skippedAccounts = [];

        // 转换并导入账号
        for (const account of accounts) {
            try {
                // 检查是否已存在（通过 access_token 匹配）
                if (skipExisting) {
                    const accountTokenStart = account.access_token?.substring(0, 50);
                    const exists = existingProviders.some(p => 
                        p.OPENAI_API_KEY?.startsWith(accountTokenStart) ||
                        p.chatgpt2apiAccountId === accountTokenStart
                    );
                    if (exists) {
                        skippedAccounts.push({
                            email: account.email,
                            reason: 'Account already exists'
                        });
                        continue;
                    }
                }

                const providerConfig = convertChatGPTAccountToProvider(account, providerType);
                existingProviders.push(providerConfig);
                importedAccounts.push({
                    uuid: providerConfig.uuid,
                    customName: providerConfig.customName,
                    email: account.email,
                    type: account.type
                });
            } catch (error) {
                logger.warn('[ChatGPT2API Integration] Failed to convert account:', error.message);
                skippedAccounts.push({
                    email: account.email,
                    reason: error.message
                });
            }
        }

        // 保存到文件
        await atomicWriteFile(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[ChatGPT2API Integration] Imported ${importedAccounts.length} accounts, skipped ${skippedAccounts.length}`);

        // 更新提供商池管理器
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'import_chatgpt2api',
            filePath: poolsFilePath,
            providerType,
            importedCount: importedAccounts.length,
            skippedCount: skippedAccounts.length,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully imported ${importedAccounts.length} accounts`,
            importedCount: importedAccounts.length,
            skippedCount: skippedAccounts.length,
            totalCount: accounts.length,
            providerType,
            importedAccounts: importedAccounts.map(a => ({ uuid: a.uuid, customName: a.customName })),
            skippedAccounts
        }));
        return true;
    } catch (error) {
        logger.error('[ChatGPT2API Integration] Import failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取 ChatGPT2API 账号预览（不导入，仅查看）
 */
export async function handlePreviewChatGPT2APIAccounts(req, res) {
    try {
        const body = await getRequestBody(req);
        const { 
            source = 'file', 
            filePath: accountsFilePath,
            apiUrl,
            apiKey
        } = body;

        if (source === 'file' && !accountsFilePath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'accountsFilePath is required for file source' } }));
            return true;
        }

        if (source === 'api' && !apiUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'apiUrl is required for api source' } }));
            return true;
        }

        let accounts = [];
        if (source === 'file') {
            accounts = loadChatGPT2APIAccounts(accountsFilePath);
        } else if (source === 'api') {
            accounts = await fetchChatGPT2APIAccountsFromAPI(apiUrl, apiKey);
        }

        // 按类型统计
        const typeStats = {};
        const statusStats = {};
        accounts.forEach(account => {
            const type = account.type || 'unknown';
            const status = account.status || 'unknown';
            typeStats[type] = (typeStats[type] || 0) + 1;
            statusStats[status] = (statusStats[status] || 0) + 1;
        });

        // 返回预览信息（脱敏）
        const preview = accounts.slice(0, 50).map(account => ({
            email: account.email || '',
            type: account.type || 'unknown',
            status: account.status || 'unknown',
            quota: account.quota || 0,
            sourceType: account.source_type || '',
            hasRefreshToken: !!account.refresh_token,
            createdAt: account.created_at || null,
            lastUsedAt: account.last_used_at || null
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            totalCount: accounts.length,
            typeStats,
            statusStats,
            preview
        }));
        return true;
    } catch (error) {
        logger.error('[ChatGPT2API Integration] Preview failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 同步 ChatGPT2API 账号状态到提供商池
 * 仅更新健康状态和配额信息，不添加新账号
 */
export async function handleSyncChatGPT2APIAccounts(req, res, currentConfig, providerPoolManager) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleSyncChatGPT2APIAccounts(req, res, currentConfig, providerPoolManager)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}

async function _handleSyncChatGPT2APIAccounts(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { 
            source = 'file', 
            filePath: accountsFilePath,
            apiUrl,
            apiKey,
            providerType = 'openai-custom'
        } = body;

        let accounts = [];
        if (source === 'file') {
            accounts = loadChatGPT2APIAccounts(accountsFilePath);
        } else if (source === 'api') {
            accounts = await fetchChatGPT2APIAccountsFromAPI(apiUrl, apiKey);
        }

        // 创建 access_token 前缀到账号的映射
        const accountMap = new Map();
        accounts.forEach(account => {
            if (account.access_token) {
                accountMap.set(account.access_token.substring(0, 50), account);
            }
        });

        // 加载现有提供商池
        const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        if (existsSync(poolsFilePath)) {
            const fileContent = readFileSync(poolsFilePath, 'utf-8');
            providerPools = JSON.parse(fileContent);
        }

        const providers = providerPools[providerType] || [];
        let updatedCount = 0;
        const updatedAccounts = [];

        for (const provider of providers) {
            const tokenPrefix = provider.OPENAI_API_KEY?.substring(0, 50) || provider.chatgpt2apiAccountId;
            const chatgptAccount = accountMap.get(tokenPrefix);
            
            if (chatgptAccount) {
                // 更新健康状态
                const oldHealthy = provider.isHealthy;
                provider.isHealthy = chatgptAccount.status === '正常';
                provider.isDisabled = chatgptAccount.status === '禁用' || chatgptAccount.status === '异常';
                
                // 更新配额
                if (chatgptAccount.quota !== undefined) {
                    provider.quota = chatgptAccount.quota;
                }
                
                // 更新 token 刷新时间
                if (chatgptAccount.last_token_refresh_at) {
                    provider.lastTokenRefreshAt = chatgptAccount.last_token_refresh_at;
                }

                // 标记为已同步
                provider.isChatGPT2APISynced = true;
                provider.chatgpt2apiAccountId = tokenPrefix;

                if (oldHealthy !== provider.isHealthy) {
                    updatedCount++;
                    updatedAccounts.push({
                        uuid: provider.uuid,
                        customName: provider.customName,
                        oldStatus: oldHealthy ? 'healthy' : 'unhealthy',
                        newStatus: provider.isHealthy ? 'healthy' : 'unhealthy'
                    });
                }
            }
        }

        // 保存到文件
        await atomicWriteFile(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[ChatGPT2API Integration] Synced ${updatedCount} account statuses`);

        // 更新提供商池管理器
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully synced ${updatedCount} accounts`,
            updatedCount,
            totalCount: providers.length,
            providerType,
            updatedAccounts
        }));
        return true;
    } catch (error) {
        logger.error('[ChatGPT2API Integration] Sync failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取集成状态和统计信息
 */
export async function handleGetChatGPT2APIIntegrationStatus(req, res, currentConfig, providerPoolManager) {
    try {
        const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        if (existsSync(poolsFilePath)) {
            const fileContent = readFileSync(poolsFilePath, 'utf-8');
            providerPools = JSON.parse(fileContent);
        }

        // 统计 ChatGPT2API 同步的账号
        const integrationStats = {};
        
        for (const [type, providers] of Object.entries(providerPools)) {
            if (Array.isArray(providers)) {
                const syncedAccounts = providers.filter(p => p.isChatGPT2APISynced);
                const healthyAccounts = syncedAccounts.filter(p => p.isHealthy && !p.isDisabled);
                
                if (syncedAccounts.length > 0) {
                    integrationStats[type] = {
                        total: syncedAccounts.length,
                        healthy: healthyAccounts.length,
                        disabled: syncedAccounts.filter(p => p.isDisabled).length,
                        unhealthy: syncedAccounts.filter(p => !p.isHealthy && !p.isDisabled).length
                    };
                }
            }
        }

        // 检查默认的 ChatGPT2API 账号文件位置
        const defaultChatGPT2APIPaths = [
            'chatgpt2api/data/accounts.json',
            'chatgpt2api/accounts.json',
            'data/accounts.json'
        ];
        
        const availableFiles = defaultChatGPT2APIPaths.filter(path => existsSync(path));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            integrationStats,
            availableAccountFiles: availableFiles,
            isProviderPoolManagerAvailable: !!providerPoolManager
        }));
        return true;
    } catch (error) {
        logger.error('[ChatGPT2API Integration] Status check failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}
