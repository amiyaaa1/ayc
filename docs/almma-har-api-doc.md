# chat.almma.ai HAR 接口文档与链路分析

来源：`chat.almma.ai.har`，共 179 条请求，75 个去重 endpoint。本文只记录结构和链路，敏感值（邮箱、密码、JWT、Turnstile secret、第三方 secret）均已省略。

## 1. 总览

- Base URL: `https://chat.almma.ai`
- 核心对话 endpoint: `POST /api/agents/chat/Azure%20Anthropic`
- 流式输出 endpoint: `GET /api/agents/chat/stream/{streamId}`
- 登录 endpoint: `POST /api/auth/login`
- 初始化数据：`/api/config`、`/api/user`、`/api/models`、`/api/subscription/usage`、`/api/convos`、`/api/presets`、`/api/mcp/*`
- 该站点形态接近 LibreChat/agent conversation tree：消息靠 `conversationId`、`messageId`、`parentMessageId` 串起来。

## 2. 鉴权与 Turnstile

### 2.1 登录接口

```http
POST /api/auth/login
Content-Type: application/json
Accept: application/json
```

请求体：

```json
{
  "email": "<email>",
  "password": "<password>",
  "turnstileToken": "<cf-turnstile-response-token>"
}
```

响应体：

```json
{
  "token": "<jwt>",
  "user": {
    "_id": "<user_id>",
    "provider": "local",
    "role": "USER",
    "termsAccepted": true,
    "personalization": { "memories": true },
    "refreshToken": []
  }
}
```

HAR 中 JWT payload 显示 `iat` 到 `exp` 约 900 秒，即观察到的 access token 有效期约 15 分钟。后续实测确认 refresh 链路存在，但不在响应体里的 `user.refreshToken` 字段中。`POST /api/auth/login` 会通过 `Set-Cookie` 下发 `refreshToken`、`token_provider`、`token`；`POST /api/auth/refresh` 带这些 cookie 时会返回新的 `{ "token": "<jwt>", "user": ... }`，新的 access token 仍然是约 900 秒有效期。只带 `Authorization: Bearer <jwt>` 调 refresh 会返回 `Refresh token not provided`。

### 2.2 token 怎么“兑换”

这里有两个不同的 token，不要混在一起：

- `turnstileToken`：Cloudflare Turnstile widget 在浏览器端产生的一次性 challenge response。
- `token`：`/api/auth/login` 在邮箱、密码、Turnstile response 验证通过后返回的业务 JWT。

实际兑换链路是：

1. 页面用 `siteKey` 渲染 Turnstile。
2. 用户或浏览器环境完成挑战，前端得到 `cf-turnstile-response`，也就是登录接口里的 `turnstileToken`。
3. 客户端调用 `POST /api/auth/login`，用 `email + password + turnstileToken` 换取业务 JWT。
4. 后续业务 API 使用该 JWT。HAR 导出里未显示 `Authorization`/`Cookie`，可能是导出时省略敏感头；工程上优先按 `Authorization: Bearer <jwt>` 调用，若服务端实现不读取 Bearer，再对照真实浏览器请求调整。

`secretKey` 不能凭空生成 `turnstileToken`。它只能在服务端校验一个已经由 Turnstile widget 产出的 response token：

```http
POST https://challenges.cloudflare.com/turnstile/v0/siteverify
Content-Type: application/x-www-form-urlencoded

secret=<turnstile_secret>&response=<cf-turnstile-response-token>&remoteip=<optional_ip>
```

返回示意：

```json
{
  "success": true,
  "challenge_ts": "...",
  "hostname": "chat.almma.ai"
}
```

对于 `chat.almma.ai` 的登录接口，通常不需要你先调用 `siteverify`；后端会在 `/api/auth/login` 内部校验。你可以在自己的自动化服务里先校验一次，用于排查 token 是否有效。

### 2.3 鉴权风险

- HAR 中 `/api/config` 返回了 `turnstile.secretKey`。`siteKey` 可以公开，`secretKey` 不应下发到浏览器或公开配置接口。建议旋转该 Turnstile secret，并修复 `/api/config`，只返回 `siteKey`。
- `/api/config` 里还出现第三方集成 secret 字段，同样建议从客户端配置中移除并旋转。
- HAR 文件包含登录请求、JWT、用户信息、完整对话流内容，应按敏感文件处理。

## 3. 初始化链路

登录前后主要初始化请求如下：

```text
GET  /
POST /api/auth/login
GET  /api/config
GET  /api/subscription
GET  /api/subscription/usage
GET  /api/subscription/booster
GET  /api/subscription/customer-portal
GET  /api/convos/folders
GET  /api/convos/folders/all/count
GET  /api/convos/folders/root/count
GET  /api/user/settings/favorites
GET  /api/agents/chat/active
GET  /api/convos?folderId=all
GET  /api/models
GET  /api/search/enable
GET  /api/roles/USER
GET  /api/user
GET  /api/user/terms
GET  /api/mcp/servers
GET  /api/mcp/connection/status
GET  /api/mcp/tools
GET  /api/keys?name=Azure%20Anthropic
GET  /api/presets
GET  /api/files/config
GET  /api/almma-system-prompts
```

关键响应：

- `/api/config`：功能开关、登录方式、`serverDomain`、Turnstile `siteKey`、界面能力开关。
- `/api/models`：按 provider 返回模型列表；HAR 中使用 `Azure Anthropic / claude-opus-4-5`。
- `/api/keys?name=Azure%20Anthropic`：返回 `{ "expiresAt": null }`，未返回真实 provider key。
- `/api/subscription/usage`：返回套餐、试用状态、消息配额。
- `/api/agents/chat/active`：返回 `{ "activeJobIds": [] }` 或运行中的 job id。
- `/api/almma-system-prompts`：返回内置系统规则启用状态和文本。

## 4. 预设与参数设置

### 4.1 查询预设

```http
GET /api/presets
```

返回数组，每项包含：

```json
{
  "_id": "<mongo_id>",
  "presetId": "<uuid>",
  "user": "<user_id>",
  "endpoint": "Azure Anthropic",
  "endpointType": "custom",
  "model": "claude-opus-4-5",
  "modelLabel": "<label>",
  "title": "<title>",
  "promptPrefix": "<optional system prompt>",
  "temperature": 1,
  "maxContextTokens": 129200,
  "max_tokens": 64000,
  "resendFiles": true,
  "useResponsesApi": true,
  "isArchived": false,
  "tags": []
}
```

### 4.2 创建预设

```http
POST /api/presets
Content-Type: application/json
```

HAR 中出现过的请求字段：

```json
{
  "presetId": null,
  "model": "claude-opus-4-5",
  "modelLabel": "<label>",
  "promptPrefix": "<optional system prompt>",
  "temperature": 1,
  "resendFiles": true,
  "maxContextTokens": 129200,
  "max_tokens": 64000,
  "useResponsesApi": true,
  "endpoint": "Azure Anthropic",
  "endpointType": "custom",
  "title": "<conversation title>"
}
```

注意：HAR 中有错误响应显示 `temperature is not supported when thinking is enabled`。当模型/代理启用 thinking 时，`temperature` 可能不被支持；自动化里建议先不传 `temperature`，或只在确认该模型支持时传。

## 5. 对话请求链路

### 5.1 新建会话并发送第一条消息

```http
POST /api/agents/chat/Azure%20Anthropic
Content-Type: application/json
```

请求体结构：

```json
{
  "text": "hi",
  "sender": "User",
  "clientTimestamp": "2026-05-08T10:40:10",
  "isCreatedByUser": true,
  "parentMessageId": "00000000-0000-0000-0000-000000000000",
  "messageId": "<uuid>",
  "error": false,
  "endpoint": "Azure Anthropic",
  "endpointType": "custom",
  "model": "claude-opus-4-5",
  "key": "never",
  "modelDisplayLabel": "Azure Anthropic",
  "isTemporary": false,
  "isRegenerate": false,
  "isContinued": false
}
```

响应：

```json
{
  "streamId": "<conversation_uuid>",
  "conversationId": "<conversation_uuid>",
  "status": "started"
}
```

然后立刻连接：

```http
GET /api/agents/chat/stream/{streamId}
Accept: text/event-stream
```

### 5.2 继续已有会话

继续对话时请求体新增 `conversationId`，并把 `parentMessageId` 指向当前分支最后一条助手消息：

```json
{
  "text": "<next user message>",
  "sender": "User",
  "clientTimestamp": "<local timestamp>",
  "isCreatedByUser": true,
  "parentMessageId": "<last_assistant_message_id>",
  "conversationId": "<conversation_id>",
  "messageId": "<new_user_message_uuid>",
  "error": false,
  "endpoint": "Azure Anthropic",
  "endpointType": "custom",
  "model": "claude-opus-4-5",
  "modelLabel": "<label>",
  "promptPrefix": "<optional system prompt>",
  "resendFiles": true,
  "maxContextTokens": 129200,
  "max_tokens": 64000,
  "useResponsesApi": true,
  "key": "never",
  "modelDisplayLabel": "Azure Anthropic",
  "isTemporary": false,
  "isRegenerate": false,
  "isContinued": false
}
```

### 5.3 重新生成

HAR 中 regenerate 请求有这些额外字段：

```json
{
  "isRegenerate": true,
  "responseMessageId": "<previous_assistant_message_id>_",
  "overrideParentMessageId": "<target_user_message_id>"
}
```

同时 `parentMessageId` 仍然指向要替换分支上的上一条助手消息。该接口用 message tree 管理分支，而不是一次传完整 `messages` 数组。

## 6. SSE 流式响应

`GET /api/agents/chat/stream/{streamId}` 返回 `text/event-stream`，每个事件大致是：

```text
event: message
data: {...json...}
```

主要 data 形态：

1. 用户消息已创建：

```json
{
  "created": true,
  "message": {
    "messageId": "<user_message_id>",
    "parentMessageId": "<parent_message_id>",
    "conversationId": "<conversation_id>",
    "sender": "User",
    "text": "<user text>",
    "isCreatedByUser": true,
    "tokenCount": 17
  },
  "streamId": "<stream_id>"
}
```

2. 模型运行步骤：

```json
{
  "event": "on_run_step",
  "data": {
    "stepIndex": 0,
    "id": "<step_id>",
    "type": "message_creation",
    "stepDetails": {
      "type": "message_creation",
      "message_creation": { "message_id": "<provider_message_id>" }
    },
    "runId": "<assistant_message_id>"
  }
}
```

3. thinking 增量：

```json
{
  "event": "on_reasoning_delta",
  "data": {
    "delta": {
      "content": [
        { "type": "think", "think": "<delta>" }
      ]
    }
  }
}
```

4. 正文增量：

```json
{
  "event": "on_message_delta",
  "data": {
    "delta": {
      "content": [
        { "index": 1, "type": "text", "text": "<delta>" }
      ]
    }
  }
}
```

5. 结束事件：

```json
{
  "final": true,
  "conversation": {
    "conversationId": "<conversation_id>",
    "endpoint": "Azure Anthropic",
    "model": "claude-opus-4-5",
    "messages": ["<mongo_message_ids>"],
    "maxContextTokens": 129200,
    "max_tokens": 64000,
    "tokenLimitReached": false,
    "totalTokensUsed": 140
  },
  "requestMessage": { "...": "..." },
  "responseMessage": {
    "messageId": "<assistant_message_id>",
    "parentMessageId": "<user_message_id>",
    "isCreatedByUser": false,
    "model": "claude-opus-4-5",
    "sender": "<label>",
    "promptTokens": 135,
    "endpoint": "Azure Anthropic",
    "text": "",
    "content": [
      { "type": "think", "think": "<reasoning>" },
      { "type": "text", "text": "<assistant answer>" }
    ],
    "attachments": []
  }
}
```

错误时 `responseMessage.content` 里可能是：

```json
[
  {
    "type": "error",
    "error": "An error occurred while processing the request: ..."
  }
]
```

## 7. 会话查询与状态

### 7.1 查询消息

```http
GET /api/messages/{conversationId}
```

返回消息数组。用户消息字段：

```json
{
  "messageId": "<uuid>",
  "conversationId": "<uuid>",
  "createdAt": "<iso>",
  "endpoint": "Azure Anthropic",
  "error": false,
  "expiredAt": null,
  "isCreatedByUser": true,
  "model": null,
  "parentMessageId": "<uuid-or-zero>",
  "sender": "User",
  "text": "<message>",
  "tokenCount": 6,
  "unfinished": false,
  "updatedAt": "<iso>"
}
```

助手消息字段：

```json
{
  "messageId": "<uuid>",
  "attachments": [],
  "content": [
    { "type": "think", "think": "<reasoning>" },
    { "type": "text", "text": "<assistant answer>" }
  ],
  "conversationId": "<uuid>",
  "endpoint": "Azure Anthropic",
  "error": false,
  "isCreatedByUser": false,
  "model": "claude-opus-4-5",
  "parentMessageId": "<user_message_id>",
  "sender": "Azure Anthropic",
  "text": "",
  "tokenCount": 112,
  "unfinished": false
}
```

### 7.2 查询状态

```http
GET /api/agents/chat/status/{conversationId}
```

返回：

```json
{ "active": false }
```

## 8. 是否支持一次性传完整上下文

按 HAR 观测，`POST /api/agents/chat/Azure%20Anthropic` 没有 `messages`、`history`、`context` 数组字段。每次发送只带：

- 当前用户输入 `text`
- 会话 ID `conversationId`
- 消息树指针 `parentMessageId/messageId`
- 模型和参数设置

因此结论是：

- 对已有会话：接口依赖服务端用 `conversationId + parentMessageId` 查历史并组装上下文，不需要客户端每次传完整上下文。
- 对外部一次性调用：HAR 中没有看到“直接传完整多轮上下文数组”的能力。
- 如果你没有在该服务端创建过历史消息，又想一次性带完整上下文，最稳妥做法是把历史压缩/格式化进单条 `text` 或 `promptPrefix`，作为一次用户消息发送。
- 另一种办法是按轮次重放历史，但每轮都会触发模型调用，不适合只想补全上下文。
- 若要真正导入历史，需要另找会话导入接口；HAR 中只在前端代码里看到导入功能痕迹，没有捕获到对应网络请求。

推荐单用户消息格式：

```text
以下是本次请求的完整上下文摘要：

系统设定：
...

历史对话摘要：
- 用户：...
- 助手：...

当前用户问题：
...
```

## 9. LibreChat Agents API 与“真 role”

这个站点是 LibreChat 二次开发，除网页聊天接口外，还暴露了 LibreChat 上游的 Agents API beta 路由。无凭证探测结果如下：

```text
GET  /api/agents/v1/models            -> 401 missing_api_key
POST /api/agents/v1/chat/completions  -> 401 missing_api_key
POST /api/agents/v1/responses         -> 401 missing_api_key
```

这说明路由存在，但需要 `Authorization: Bearer <api_key>`。注意这里的 `<api_key>` 是 LibreChat 远程 Agents API key，不是 `/api/auth/login` 返回的 15 分钟网页登录 JWT。

这条接口可以实现更接近 OpenAI 兼容协议的“真 role”：

```http
POST /api/agents/v1/chat/completions
Authorization: Bearer <librechat_agents_api_key>
Content-Type: application/json
```

```json
{
  "model": "<agent_id>",
  "messages": [
    { "role": "system", "content": "You are a concise assistant." },
    { "role": "user", "content": "第一轮问题" },
    { "role": "assistant", "content": "第一轮回答" },
    { "role": "user", "content": "当前问题" }
  ],
  "stream": true
}
```

区别：

- `/api/agents/chat/{endpoint}`：网页 UI 内部接口，传 `text + conversationId + parentMessageId`，不直接接受完整 `messages` 数组。
- `/api/agents/v1/chat/completions`：OpenAI-compatible Agents API，接受 `messages` 数组和 `role` 字段，但 `model` 是 agent id，不是普通 provider model 名称。
- `/api/agents/v1/responses`：Open Responses 形态，适合 agentic/工具/语义事件流，通常用 `input`，也可能接受更结构化输入，具体以该站当前实现为准。

要使用这条路线，通常需要：

1. 登录网页。
2. 在 Account Settings / API Keys 里创建 API key，前端包里可见 “Create API Key” UI。
3. 用该 key 请求 `GET /api/agents/v1/models`，拿可用 agent id。
4. 把 agent id 放到 `model` 字段，调用 `chat/completions`。

如果只是想把一个普通 `Azure Anthropic / claude-opus-4-5` 当模型传完整 role 历史，HAR 中没有发现对应的非-agent OpenAI-compatible endpoint；上游文档也把该能力描述为 Agents API，而不是网页聊天接口。

## 10. 最小自动化顺序

1. 获取 Turnstile response token。
2. 可选：用 `secretKey` 调用 Cloudflare `siteverify` 校验 response token。
3. `POST /api/auth/login` 换业务 JWT。
4. `GET /api/models` 确认 provider/model 可用。
5. `GET /api/keys?name=Azure%20Anthropic` 确认 provider key 状态。
6. `POST /api/agents/chat/Azure%20Anthropic` 发送消息。
7. `GET /api/agents/chat/stream/{streamId}` 读取 SSE 到 `final: true`。
8. 可选：`GET /api/messages/{conversationId}` 拉取服务端保存的消息树。

如果使用“真 role”路线，则改为：

1. 创建或获取 LibreChat Agents API key。
2. `GET /api/agents/v1/models` 找 agent id。
3. `POST /api/agents/v1/chat/completions` 传 `messages: [{ role, content }]`。
