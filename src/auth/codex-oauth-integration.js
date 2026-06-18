import { existsSync, readFileSync } from 'fs';
import logger from '../utils/logger.js';
import { getRequestBody, generateUUID } from '../utils/common.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { normalizeProviderConfigFields } from '../utils/provider-config-normalizer.js';

/**
 * Codex (ChatGPT2API) OAuth 账号集成模块
 * 
 * 专门处理从 ChatGPT2API 注册机导入的 OpenAI OAuth 账号
 * 支持自动刷新 token、账号状态同步、批量管理
 */

/**
 * Codex 账号数据结构
 */
const CODEX_ACCOUNT_SCHEMA = {
    access_token: 'string',
    refresh_token: 'string',
    id_token: 'string',
    email: 'string',
    password: 'string', // 可选，用于密码重新登录
    type: 'string', // free, Plus, Pro, Enterprise
    source_type: 'string', // web, oauth_login, password
    quota: 'number',
    status: 'string', // 正常, 禁用, 限流, 异常
    user_id: 'string',
    proxy: 'string',
    created_at: 'string',
    last_used_at: 'string',
    last_token_refresh_at: 'string'
};

/**
 * 验证 Codex 账号完整性
 * @param {Object} account - 账号对象
 * @returns {Object} 验证结果 { valid: boolean, errors: string[] }
 */
export function validateCodexAccount(account) {
    const errors = [];
    
    if (!account.access_token) {
        errors.push('Missing required field: access_token');
    }
    if (!account.refresh_token) {
        errors.push('Missing required field: refresh_token');
    }
    if (!account.id_token) {
        errors.push('Missing required field: id_token');
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * 将 Codex 账号转换为 AIClient2API openai-codex-oauth 提供商配置
 * @param {Object} codexAccount - Codex 账号对象
 * @param {Object} options - 配置选项
 * @returns {Object} 提供商配置
 */
export function convertCodexToProviderConfig(codexAccount, options = {}) {
    const validation = validateCodexAccount(codexAccount);
    if (!validation.valid) {
        throw new Error(`Invalid Codex account: ${validation.errors.join(', ')}`);
    }

    const accountType = codexAccount.type || 'unknown';
    const displayName = codexAccount.email 
        ? `${codexAccount.email} (${accountType})` 
        : `Codex Account (${accountType})`;

    // 根据账号类型确定支持的模型
    let supportedModels = [];
    switch (accountType.toLowerCase()) {
        case 'pro':
        case 'enterprise':
            supportedModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'o1', 'o1-mini'];
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
        customName: displayName,
        isHealthy: codexAccount.status === '正常',
        isDisabled: codexAccount.status === '禁用' || codexAccount.status === '异常',
        needsRefresh: false,
        lastUsed: codexAccount.last_used_at || null,
        usageCount: 0,
        errorCount: 0,
        lastErrorTime: null,
        lastErrorMessage: null,
        
        // OAuth 凭据配置
        OPENAI_OAUTH_ACCESS_TOKEN: codexAccount.access_token,
        OPENAI_OAUTH_REFRESH_TOKEN: codexAccount.refresh_token,
        OPENAI_OAUTH_ID_TOKEN: codexAccount.id_token,
        
        // 账号信息
        accountType: accountType,
        sourceType: codexAccount.source_type || 'oauth_login',
        email: codexAccount.email || '',
        userId: codexAccount.user_id || '',
        password: codexAccount.password || '', // 用于密码重新登录
        quota: codexAccount.quota || 0,
        proxy: codexAccount.proxy || '',
        
        // 模型配置
        supportedModels: supportedModels,
        notSupportedModels: [],
        OPENAI_MODEL: 'gpt-4o', // 默认模型
        
        // 时间戳
        createdAt: codexAccount.created_at || null,
        lastTokenRefreshAt: codexAccount.last_token_refresh_at || null,
        
        // Codex 同步标记
        codexAccountId: codexAccount.access_token.substring(0, 50),
        isCodexSynced: true,
        
        // 健康检查配置
        healthCheckModel: 'gpt-4o-mini',
        refreshThreshold: 300 // 5分钟
    };

    return normalizeProviderConfigFields(providerConfig);
}

/**
 * 从本地文件加载 Codex 账号
 * @param {string} filePath - 账号文件路径
 * @returns {Array} 账号列表
 */
export function loadCodexAccountsFromFile(filePath) {
    if (!existsSync(filePath)) {
        throw new Error(`Codex accounts file not found: ${filePath}`);
    }

    try {
        const content = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        
        // 支持对象格式（key 是 access_token）或数组格式
        if (Array.isArray(data)) {
            return data;
        } else if (typeof data === 'object' && data !== null) {
            return Object.values(data);
        }
        return [];
    } catch (error) {
        logger.error('[Codex Integration] Failed to load accounts:', error.message);
        throw new Error(`Failed to load Codex accounts: ${error.message}`);
    }
}

/**
 * 从 Codex API 获取账号列表
 * @param {string} apiUrl - Codex API 地址
 * @param {string} apiKey - API 密钥
 * @returns {Promise<Array>} 账号列表
 */
export async function fetchCodexAccountsFromAPI(apiUrl, apiKey) {
    try {
        const url = `${apiUrl.replace(/\/$/, '')}/api/accounts`;
        const headers = {
            'Content-Type': 'application/json'
        };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await fetch(url, { headers, timeout: 30000 });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data.items || data.accounts || [];
    } catch (error) {
        logger.error('[Codex Integration] Failed to fetch accounts from API:', error.message);
        throw error;
    }
}

/**
 * 批量导入 Codex 账号到提供商池
 */
export async function handleImportCodexAccounts(req, res, currentConfig, providerPoolManager) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleImportCodexAccounts(req, res, currentConfig, providerPoolManager)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}

async function _handleImportCodexAccounts(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { 
            source = 'file', 
            filePath: accountsFilePath,
            apiUrl,
            apiKey,
            providerType = 'openai-codex-oauth',
            filterStatus = null,
            filterType = null,
            skipExisting = true,
            skipInvalid = true
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
        if (body.accounts && Array.isArray(body.accounts) && body.accounts.length > 0) {
            // 直接接收账号数组（ChatGPT2API 推送模式）
            accounts = body.accounts;
        } else if (source === 'file') {
            accounts = loadCodexAccountsFromFile(accountsFilePath);
        } else if (source === 'api') {
            accounts = await fetchCodexAccountsFromAPI(apiUrl, apiKey);
        }

        if (accounts.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No accounts to import',
                importedCount: 0,
                skippedCount: 0,
                invalidCount: 0,
                totalCount: 0
            }));
            return true;
        }

        // 应用过滤
        if (filterStatus) {
            accounts = accounts.filter(a => a.status === filterStatus);
        }
        if (filterType) {
            accounts = accounts.filter(a => a.type && a.type.toLowerCase() === filterType.toLowerCase());
        }

        // 加载现有提供商池
        const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        if (existsSync(poolsFilePath)) {
            try {
                const fileContent = readFileSync(poolsFilePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                logger.warn('[Codex Integration] Failed to read provider pools:', readError.message);
            }
        }

        if (!providerPools[providerType]) {
            providerPools[providerType] = [];
        }

        const existingProviders = providerPools[providerType];
        const importedAccounts = [];
        const skippedAccounts = [];
        const invalidAccounts = [];

        // 转换并导入账号
        for (const account of accounts) {
            try {
                // 验证账号
                const validation = validateCodexAccount(account);
                if (!validation.valid) {
                    if (skipInvalid) {
                        invalidAccounts.push({
                            email: account.email,
                            errors: validation.errors
                        });
                        continue;
                    }
                    throw new Error(validation.errors.join(', '));
                }

                // 检查是否已存在
                if (skipExisting) {
                    const accountId = account.access_token?.substring(0, 50);
                    const exists = existingProviders.some(p => 
                        p.OPENAI_OAUTH_ACCESS_TOKEN?.startsWith(accountId) ||
                        p.codexAccountId === accountId
                    );
                    if (exists) {
                        skippedAccounts.push({
                            email: account.email,
                            reason: 'Account already exists'
                        });
                        continue;
                    }
                }

                const providerConfig = convertCodexToProviderConfig(account);
                existingProviders.push(providerConfig);
                importedAccounts.push({
                    uuid: providerConfig.uuid,
                    customName: providerConfig.customName,
                    email: account.email,
                    type: account.type
                });
            } catch (error) {
                logger.warn('[Codex Integration] Failed to process account:', error.message);
                if (!invalidAccounts.some(a => a.email === account.email)) {
                    invalidAccounts.push({
                        email: account.email,
                        errors: [error.message]
                    });
                }
            }
        }

        // 保存到文件
        await atomicWriteFile(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[Codex Integration] Imported ${importedAccounts.length} accounts, skipped ${skippedAccounts.length}, invalid ${invalidAccounts.length}`);

        // 更新提供商池管理器
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'import_codex',
            filePath: poolsFilePath,
            providerType,
            importedCount: importedAccounts.length,
            skippedCount: skippedAccounts.length,
            invalidCount: invalidAccounts.length,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully imported ${importedAccounts.length} Codex accounts`,
            importedCount: importedAccounts.length,
            skippedCount: skippedAccounts.length,
            invalidCount: invalidAccounts.length,
            totalCount: accounts.length,
            providerType,
            importedAccounts: importedAccounts.map(a => ({ uuid: a.uuid, customName: a.customName })),
            skippedAccounts,
            invalidAccounts
        }));
        return true;
    } catch (error) {
        logger.error('[Codex Integration] Import failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 预览 Codex 账号（不导入，仅查看统计信息）
 */
export async function handlePreviewCodexAccounts(req, res) {
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
            accounts = loadCodexAccountsFromFile(accountsFilePath);
        } else if (source === 'api') {
            accounts = await fetchCodexAccountsFromAPI(apiUrl, apiKey);
        }

        // 按类型和状态统计
        const typeStats = {};
        const statusStats = {};
        const sourceStats = {};
        let validCount = 0;
        
        accounts.forEach(account => {
            const type = account.type || 'unknown';
            const status = account.status || 'unknown';
            const sourceType = account.source_type || 'unknown';
            
            typeStats[type] = (typeStats[type] || 0) + 1;
            statusStats[status] = (statusStats[status] || 0) + 1;
            sourceStats[sourceType] = (sourceStats[sourceType] || 0) + 1;
            
            if (validateCodexAccount(account).valid) {
                validCount++;
            }
        });

        // 返回预览信息
        const preview = accounts.slice(0, 50).map(account => {
            const validation = validateCodexAccount(account);
            return {
                email: account.email || '',
                type: account.type || 'unknown',
                status: account.status || 'unknown',
                sourceType: account.source_type || '',
                quota: account.quota || 0,
                hasRefreshToken: !!account.refresh_token,
                hasIdToken: !!account.id_token,
                isValid: validation.valid,
                validationErrors: validation.errors
            };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            totalCount: accounts.length,
            validCount,
            invalidCount: accounts.length - validCount,
            typeStats,
            statusStats,
            sourceStats,
            preview
        }));
        return true;
    } catch (error) {
        logger.error('[Codex Integration] Preview failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 同步 Codex 账号状态到提供商池
 */
export async function handleSyncCodexAccounts(req, res, currentConfig, providerPoolManager) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleSyncCodexAccounts(req, res, currentConfig, providerPoolManager)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}

async function _handleSyncCodexAccounts(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { 
            source = 'file', 
            filePath: accountsFilePath,
            apiUrl,
            apiKey,
            providerType = 'openai-codex-oauth',
            updateTokens = false
        } = body;

        let accounts = [];
        if (source === 'file') {
            accounts = loadCodexAccountsFromFile(accountsFilePath);
        } else if (source === 'api') {
            accounts = await fetchCodexAccountsFromAPI(apiUrl, apiKey);
        }

        // 创建账号映射
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
            const tokenPrefix = provider.OPENAI_OAUTH_ACCESS_TOKEN?.substring(0, 50) || provider.codexAccountId;
            const codexAccount = accountMap.get(tokenPrefix);
            
            if (codexAccount) {
                let hasChanges = false;
                const oldHealthy = provider.isHealthy;
                
                // 更新状态
                const newHealthy = codexAccount.status === '正常';
                const newDisabled = codexAccount.status === '禁用' || codexAccount.status === '异常';
                
                if (provider.isHealthy !== newHealthy) {
                    provider.isHealthy = newHealthy;
                    hasChanges = true;
                }
                if (provider.isDisabled !== newDisabled) {
                    provider.isDisabled = newDisabled;
                    hasChanges = true;
                }
                
                // 更新配额
                if (codexAccount.quota !== undefined && provider.quota !== codexAccount.quota) {
                    provider.quota = codexAccount.quota;
                    hasChanges = true;
                }
                
                // 更新 token（可选）
                if (updateTokens) {
                    if (codexAccount.refresh_token && provider.OPENAI_OAUTH_REFRESH_TOKEN !== codexAccount.refresh_token) {
                        provider.OPENAI_OAUTH_REFRESH_TOKEN = codexAccount.refresh_token;
                        hasChanges = true;
                    }
                    if (codexAccount.id_token && provider.OPENAI_OAUTH_ID_TOKEN !== codexAccount.id_token) {
                        provider.OPENAI_OAUTH_ID_TOKEN = codexAccount.id_token;
                        hasChanges = true;
                    }
                }
                
                // 更新 token 刷新时间
                if (codexAccount.last_token_refresh_at) {
                    provider.lastTokenRefreshAt = codexAccount.last_token_refresh_at;
                }
                
                provider.isCodexSynced = true;
                provider.codexAccountId = tokenPrefix;

                if (hasChanges) {
                    updatedCount++;
                    updatedAccounts.push({
                        uuid: provider.uuid,
                        customName: provider.customName,
                        statusChanged: oldHealthy !== newHealthy,
                        oldStatus: oldHealthy ? 'healthy' : 'unhealthy',
                        newStatus: newHealthy ? 'healthy' : 'unhealthy'
                    });
                }
            }
        }

        // 保存到文件
        await atomicWriteFile(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[Codex Integration] Synced ${updatedCount} account statuses`);

        // 更新提供商池管理器
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully synced ${updatedCount} Codex accounts`,
            updatedCount,
            totalCount: providers.length,
            providerType,
            updatedAccounts
        }));
        return true;
    } catch (error) {
        logger.error('[Codex Integration] Sync failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 获取 Codex 集成状态
 */
export async function handleGetCodexIntegrationStatus(req, res, currentConfig, providerPoolManager) {
    try {
        const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        if (existsSync(poolsFilePath)) {
            const fileContent = readFileSync(poolsFilePath, 'utf-8');
            providerPools = JSON.parse(fileContent);
        }

        // 统计 Codex 同步的账号
        const integrationStats = {};
        
        for (const [type, providers] of Object.entries(providerPools)) {
            if (Array.isArray(providers)) {
                const syncedAccounts = providers.filter(p => p.isCodexSynced);
                const healthyAccounts = syncedAccounts.filter(p => p.isHealthy && !p.isDisabled);
                
                if (syncedAccounts.length > 0) {
                    integrationStats[type] = {
                        total: syncedAccounts.length,
                        healthy: healthyAccounts.length,
                        disabled: syncedAccounts.filter(p => p.isDisabled).length,
                        unhealthy: syncedAccounts.filter(p => !p.isHealthy && !p.isDisabled).length,
                        withRefreshToken: syncedAccounts.filter(p => p.OPENAI_OAUTH_REFRESH_TOKEN).length
                    };
                }
            }
        }

        // 检查默认的 Codex 账号文件位置
        const defaultCodexPaths = [
            'chatgpt2api/data/accounts.json',
            'chatgpt2api/accounts.json',
            'data/accounts.json',
            'accounts.json'
        ];
        
        const availableFiles = defaultCodexPaths.filter(path => existsSync(path));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            integrationStats,
            availableAccountFiles: availableFiles,
            isProviderPoolManagerAvailable: !!providerPoolManager
        }));
        return true;
    } catch (error) {
        logger.error('[Codex Integration] Status check failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}
