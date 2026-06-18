# ChatGPT2API (Codex) 账号池集成文档

## 概述

本文档说明如何将 ChatGPT2API 注册机的账号池与 AIClient2API 的提供商池管理系统进行集成。

## 架构说明

```
ChatGPT2API 注册机            AIClient2API 主系统
┌─────────────────┐           ┌─────────────────────┐
│ 账号池存储      │  导入/同步  │  提供商池管理       │
│  - accounts.json│──────────►│  - provider_pools.json│
│  - SQLite       │           │  - 负载均衡          │
│  - Git 同步     │           │  - 健康检查          │
│  自动刷新 token │           │  - 自动刷新 token    │
└─────────────────┘           └─────────────────────┘
         │                              │
         └─────────── REST API ─────────┘
```

## API 端点

### 1. 获取集成状态

**GET** `/api/codex/status`

获取当前 Codex 集成状态和统计信息。

**响应示例：**
```json
{
  "success": true,
  "integrationStats": {
    "openai-codex-oauth": {
      "total": 150,
      "healthy": 142,
      "disabled": 5,
      "unhealthy": 3,
      "withRefreshToken": 150
    }
  },
  "availableAccountFiles": [
    "chatgpt2api/data/accounts.json",
    "data/accounts.json"
  ],
  "isProviderPoolManagerAvailable": true
}
```

---

### 2. 预览账号（不导入）

**POST** `/api/codex/preview`

预览 ChatGPT2API 账号池中的账号，不实际导入。

**请求体：**
```json
{
  "source": "file",
  "filePath": "chatgpt2api/data/accounts.json",
  "apiUrl": "http://localhost:8000",
  "apiKey": "your-api-key"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source | string | 是 | 数据源类型: `file` 或 `api` |
| filePath | string | 否 | 账号文件路径 (source=file 时必填) |
| apiUrl | string | 否 | ChatGPT2API API 地址 (source=api 时必填) |
| apiKey | string | 否 | API 密钥 |

**响应示例：**
```json
{
  "success": true,
  "totalCount": 150,
  "validCount": 148,
  "invalidCount": 2,
  "typeStats": {
    "free": 50,
    "Plus": 80,
    "Pro": 20
  },
  "statusStats": {
    "正常": 142,
    "限流": 5,
    "禁用": 3
  },
  "sourceStats": {
    "oauth_login": 140,
    "password": 10
  },
  "preview": [
    {
      "email": "user1@example.com",
      "type": "Plus",
      "status": "正常",
      "sourceType": "oauth_login",
      "quota": 100,
      "hasRefreshToken": true,
      "hasIdToken": true,
      "isValid": true,
      "validationErrors": []
    }
  ]
}
```

---

### 3. 导入账号到提供商池

**POST** `/api/codex/import`

将 ChatGPT2API 账号导入到 AIClient2API 提供商池。

**请求体：**
```json
{
  "source": "file",
  "filePath": "chatgpt2api/data/accounts.json",
  "apiUrl": "http://localhost:8000",
  "apiKey": "your-api-key",
  "providerType": "openai-codex-oauth",
  "filterStatus": "正常",
  "filterType": "Plus",
  "skipExisting": true,
  "skipInvalid": true
}
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| source | string | 是 | - | 数据源类型: `file` 或 `api` |
| filePath | string | 否 | - | 账号文件路径 |
| apiUrl | string | 否 | - | ChatGPT2API API 地址 |
| apiKey | string | 否 | - | API 密钥 |
| providerType | string | 否 | `openai-codex-oauth` | 目标提供商类型 |
| filterStatus | string | 否 | null | 按状态过滤: `正常`, `限流`, `禁用`, `异常` |
| filterType | string | 否 | null | 按账号类型过滤: `free`, `Plus`, `Pro`, `Enterprise` |
| skipExisting | boolean | 否 | true | 跳过已存在的账号 |
| skipInvalid | boolean | 否 | true | 跳过验证失败的账号 |

**响应示例：**
```json
{
  "success": true,
  "message": "Successfully imported 148 Codex accounts",
  "importedCount": 148,
  "skippedCount": 2,
  "invalidCount": 0,
  "totalCount": 150,
  "providerType": "openai-codex-oauth",
  "importedAccounts": [
    {
      "uuid": "abc123-def456-...",
      "customName": "user1@example.com (Plus)"
    }
  ],
  "skippedAccounts": [
    {
      "email": "user2@example.com",
      "reason": "Account already exists"
    }
  ],
  "invalidAccounts": []
}
```

---

### 4. 同步账号状态

**POST** `/api/codex/sync`

从 ChatGPT2API 同步账号状态到 AIClient2API 提供商池（健康状态、配额、token 等）。

**请求体：**
```json
{
  "source": "file",
  "filePath": "chatgpt2api/data/accounts.json",
  "apiUrl": "http://localhost:8000",
  "apiKey": "your-api-key",
  "providerType": "openai-codex-oauth",
  "updateTokens": false
}
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| source | string | 是 | - | 数据源类型 |
| filePath | string | 否 | - | 账号文件路径 |
| apiUrl | string | 否 | - | ChatGPT2API API 地址 |
| apiKey | string | 否 | - | API 密钥 |
| providerType | string | 否 | `openai-codex-oauth` | 提供商类型 |
| updateTokens | boolean | 否 | false | 是否更新 refresh_token 和 id_token |

**响应示例：**
```json
{
  "success": true,
  "message": "Successfully synced 5 Codex accounts",
  "updatedCount": 5,
  "totalCount": 150,
  "providerType": "openai-codex-oauth",
  "updatedAccounts": [
    {
      "uuid": "abc123-def456-...",
      "customName": "user1@example.com (Plus)",
      "statusChanged": true,
      "oldStatus": "unhealthy",
      "newStatus": "healthy"
    }
  ]
}
```

---

## 账号数据格式转换

### ChatGPT2API 原始格式

```json
{
  "access_token": "eyJ0eXAiOi...",
  "refresh_token": "v1:1234567890abcdef...",
  "id_token": "eyJraWQ...",
  "email": "user@example.com",
  "password": "password123",
  "type": "Plus",
  "source_type": "oauth_login",
  "quota": 100,
  "status": "正常",
  "user_id": "user-abc123",
  "proxy": "http://proxy:8080",
  "created_at": "2024-01-01T00:00:00Z",
  "last_used_at": "2024-01-15T12:00:00Z",
  "last_token_refresh_at": "2024-01-15T11:00:00Z"
}
```

### AIClient2API 提供商格式

```json
{
  "uuid": "generated-uuid",
  "customName": "user@example.com (Plus)",
  "isHealthy": true,
  "isDisabled": false,
  "needsRefresh": false,
  "lastUsed": "2024-01-15T12:00:00Z",
  "usageCount": 0,
  "errorCount": 0,
  
  "OPENAI_OAUTH_ACCESS_TOKEN": "eyJ0eXAiOi...",
  "OPENAI_OAUTH_REFRESH_TOKEN": "v1:12345...",
  "OPENAI_OAUTH_ID_TOKEN": "eyJraWQ...",
  
  "accountType": "Plus",
  "sourceType": "oauth_login",
  "email": "user@example.com",
  "userId": "user-abc123",
  "password": "password123",
  "quota": 100,
  "proxy": "http://proxy:8080",
  
  "supportedModels": ["gpt-4o", "gpt-4o-mini", "gpt-4", "gpt-3.5-turbo"],
  "notSupportedModels": [],
  "OPENAI_MODEL": "gpt-4o",
  
  "createdAt": "2024-01-01T00:00:00Z",
  "lastTokenRefreshAt": "2024-01-15T11:00:00Z",
  
  "codexAccountId": "eyJ0eXAiOi...",
  "isCodexSynced": true,
  
  "healthCheckModel": "gpt-4o-mini",
  "refreshThreshold": 300
}
```

---

## 账号类型与支持模型映射

| 账号类型 | 支持的模型 |
|---------|-----------|
| free | gpt-4o-mini, gpt-3.5-turbo |
| Plus | gpt-4o, gpt-4o-mini, gpt-4, gpt-3.5-turbo |
| Pro / Enterprise | gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4, gpt-3.5-turbo, o1, o1-mini |

---

## 使用场景

### 场景 1: 首次批量导入

1. 确保 ChatGPT2API 账号文件存在: `chatgpt2api/data/accounts.json`
2. 调用预览接口确认数据:
   ```bash
   curl -X POST http://localhost:3000/api/codex/preview \
     -H "Content-Type: application/json" \
     -d '{"source": "file", "filePath": "chatgpt2api/data/accounts.json"}'
   ```
3. 执行导入:
   ```bash
   curl -X POST http://localhost:3000/api/codex/import \
     -H "Content-Type: application/json" \
     -d '{
       "source": "file",
       "filePath": "chatgpt2api/data/accounts.json",
       "filterStatus": "正常",
       "skipExisting": true
     }'
   ```

### 场景 2: 定期同步状态

建议每天同步一次账号状态，确保健康状态准确：

```bash
curl -X POST http://localhost:3000/api/codex/sync \
  -H "Content-Type: application/json" \
  -d '{
    "source": "file",
    "filePath": "chatgpt2api/data/accounts.json",
    "updateTokens": true
  }'
```

### 场景 3: 从远程 ChatGPT2API 实例导入

如果 ChatGPT2API 运行在另一台服务器：

```bash
curl -X POST http://localhost:3000/api/codex/import \
  -H "Content-Type: application/json" \
  -d '{
    "source": "api",
    "apiUrl": "http://codex-server:8000",
    "apiKey": "your-secret-key",
    "filterType": "Pro"
  }'
```

---

## 文件位置

### 默认搜索路径

系统会自动搜索以下位置的账号文件：

- `chatgpt2api/data/accounts.json`
- `chatgpt2api/accounts.json`
- `data/accounts.json`
- `accounts.json`

### 提供商池文件

- `configs/provider_pools.json` - AIClient2API 提供商池配置

---

## 安全说明

1. **敏感数据保护**：所有 API 响应中的 access_token、refresh_token 等敏感信息都会被脱敏显示（只显示前几位和后几位）
2. **文件权限**：确保账号文件有适当的文件权限保护
3. **API 认证**：建议为 ChatGPT2API API 配置访问密钥
4. **HTTPS**：生产环境中请使用 HTTPS 传输账号数据

---

## 故障排除

### 问题: 导入后账号显示为不健康

**解决方案：**
1. 检查 ChatGPT2API 中账号的状态是否为"正常"
2. 运行健康检查: `POST /api/providers/openai-codex-oauth/health-check`
3. 检查账号的 token 是否有效

### 问题: 账号验证失败

**常见原因：**
- 缺少 `refresh_token` 或 `id_token`
- `access_token` 格式不正确

**解决方案：**
1. 使用预览接口检查账号有效性: `POST /api/codex/preview`
2. 在 ChatGPT2API 中重新获取完整的账号信息

### 问题: 找不到账号文件

**解决方案：**
1. 确认文件路径正确
2. 检查文件权限
3. 使用绝对路径

---

## 相关文档

- [ChatGPT2API 官方文档](https://github.com/your-org/chatgpt2api)
- [AIClient2API 提供商池管理文档](./PROVIDER_POOL.md)
- [OAuth Token 刷新机制](./OAUTH_REFRESH.md)
