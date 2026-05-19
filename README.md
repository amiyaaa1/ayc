# Almma OpenAI Proxy

本项目把 Almma/LibreChat 二开站点包装成本地 OpenAI-compatible 服务，并自动维护后台账号池。

核心能力：

- 自动注册 Almma 账号、收邮件验证、登录。
- 每个账号创建一个 Almma Agents API key。
- 每个账号 key 默认每天最多调用 `500` 次，额度按 Almma 规则每天 `08:00` 北京时间刷新。
- 注册成功后会调用 `/api/subscription/usage`、`/api/subscription`、`/api/user` 获取账号真实到期时间；到期后自动禁用。
- Almma 网页登录 JWT 约 15 分钟有效；服务会保存登录响应里的 refresh cookie，过期时优先调用 `/api/auth/refresh`，刷新失败才重新登录并求解 Turnstile。
- 有效账号池上限默认 `5` 个。
- 自动补号规则：账号过期或有效账号数低于上限时补到设定上限；单个账号当日额度耗尽不会触发补号；当所有有效账号当日额度耗尽，或有效账号池当日总剩余额度低于总额度 `10%` 时，每次自动任务额外补 `1` 个号，同一个北京时间日期内最多额外补到“账号上限”个。
- 调用路由采用优先填充策略：优先选择当天已调用次数最高且尚未耗尽的账号，尽量用满一个账号后再切换到下一个。
- Token 消耗透传为 OpenAI/NewAPI 易识别格式：非流式返回标准 `usage.prompt_tokens/completion_tokens/total_tokens`；流式会自动向上游请求 usage，并在 `[DONE]` 前输出独立的 `choices: []` usage chunk。
- 每个账号默认创建两个 agent，对外模型名：
  - `Azure-Anthropic/claude-opus-4-5`
  - `Azure-Anthropic/claude-opus-4-1`
- 默认创建 Agent 时不传 `model_parameters`，避免依赖上游二开站点对 `maxContextTokens`、`max_tokens` 等参数的私有处理。
- 管理页会通过 Almma `/api/models` 拉取上游模型列表并缓存 24 小时；手动添加 Agent 时会先在单个账号上创建并做一次最小调用测试，测试成功后可批量添加到所有可用账号，并写入默认 Agent 列表。
- 管理页默认 Agent 列表里的删除按钮会同步移除默认配置，并删除所有现有账号上的对应上游 Agent。
- 对外提供：
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- 自带管理页面：`/admin`

## 目录

```text
almma-openai-proxy/
  server.mjs
  config.json
  .env.example
  Dockerfile
  docker-compose.yml
  turnstile-solver/
  data/
  docs/
  tools/
```

## 准备

1. 复制配置：

```bash
cp .env.example .env
```

2. 填写 `.env`：

```env
MOEMAIL_BASE_URL=https://mail.mui.moe
MOEMAIL_API_KEY=你的 mail.mui.moe API key
ALMMA_AGENT_INSTRUCTIONS=
ALMMA_SERVICE_API_KEY=svc-your-stable-key
ALMMA_ADMIN_API_KEY=adm-your-stable-key
```

分发包默认不带 Agent 系统提示词。`ALMMA_AGENT_INSTRUCTIONS` 和 `ALMMA_ACCOUNT_PASSWORD` 都可以留空。Agent 指令也可以在管理页面里改；密码留空时服务会为每个账号生成随机密码并写入 `data/state.json`。

临时邮箱域名在 `config.json` 的 `mail.domain` 里配置。当前本地测试确认 `moyii.de` 可以创建邮箱，所以默认使用 `moyii.de`；如果你的邮件服务配置变化，先调 `GET /api/config` 看 `emailDomains` 后再改这里。

## Turnstile Solver

默认 `config.json` 里：

```json
"solverBaseUrl": "http://turnstile-solver:5000"
```

`docker-compose.yml` 已包含 `turnstile-solver` 服务，会从本项目内的 `turnstile-solver/` 构建。所以部署时只需要上传整个 `almma-openai-proxy/` 目录。
Docker 部署默认启用 lazy browser 模式：没有注册/登录求解 Turnstile 任务时不会常驻 Chromium；求解任务开始时临时启动，任务结束后关闭。

当前 `docker-compose.yml` 会把主服务和 `turnstile-solver` 同时加入外部 Docker 网络 `warp-net`，并通过 `http://warp:1080` 走本地 Docker 部署的 WARP 代理。部署前需要保证已有名为 `warp` 的容器在 `warp-net` 网络内，并监听容器端口 `1080`。

```text
almma-openai-proxy/
  turnstile-solver/
  server.mjs
  docker-compose.yml
```

如果你不使用 Docker，直接用 Node 本地运行服务，或者 solver 单独部署在别处，可以把 `solverBaseUrl` 改成：

```json
"http://127.0.0.1:5000"
```

Turnstile 求解可能偶发返回 `ERROR_CAPTCHA_UNSOLVABLE`。主服务默认会按 `turnstile.maxAttempts: 3` 重试，重试间隔由 `turnstile.retryDelayMs` 控制。


## Zeabur 单项目部署（主服务 + Turnstile Solver 同容器）

> Zeabur 如果未手动指定 Dockerfile，默认会读取仓库根目录 `Dockerfile`。
> 现在根目录 `Dockerfile` 已与 `Dockerfile.zeabur` 保持同一套“单容器（主服务+solver）”启动逻辑，避免误用精简镜像导致只能启动主服务。

如果你在 Zeabur 上不方便维护多服务内网互联，可以直接使用仓库里的 `Dockerfile.zeabur`，一个项目同时拉起：

- OpenAI 代理服务（`8787`）
- Turnstile solver（容器内 `5000`，仅本机访问）

部署要点：

1. 在 Zeabur 新建项目并导入此仓库。
2. Build/Dockerfile 路径指定为 `Dockerfile.zeabur`。
3. 挂载持久化目录到 `/app/data`（用于保存 `data/state.json`）。
4. 在环境变量中至少配置：
   - `MOEMAIL_BASE_URL`
   - `MOEMAIL_API_KEY`
   - `ALMMA_SERVICE_API_KEY`
   - `ALMMA_ADMIN_API_KEY`
   - （可选）`ALMMA_OUTBOUND_PROXY`
5. 启动端口使用 `8787`，访问 `/admin` 进入管理页面。

> 注意：容器启动不再强制依赖 `/app/.env` 文件；Zeabur 直接在面板配置环境变量即可。

`Dockerfile.zeabur` 默认会把 `turnstile.solverBaseUrl` 注入为 `http://127.0.0.1:5000`，不再依赖 `turnstile-solver` 独立容器和内部 DNS。

说明：Turnstile solver 需要 Chromium（无头浏览器）。在 `Dockerfile.zeabur` 里通过 `python3 -m patchright install chromium` 在镜像构建阶段安装，所以运行日志里通常看不到安装过程；只有构建日志里能看到。

另外，Debian 12 镜像启用了 PEP 668（externally managed environment），Dockerfile 已改为在 `/opt/venv` 中安装 solver 的 Python 依赖，避免 `pip3 install` 构建报错。

## Docker 部署

```bash
docker compose up -d --build
```

上传服务器时，整个 `almma-openai-proxy/` 目录一起传即可。

打开管理面板：

```text
http://服务器IP:8787/admin
```

页面里填 `ALMMA_ADMIN_API_KEY`，然后可以：

- 查看账号/key/agent 状态。
- 创建新账号和默认两个 agent。
- 给现有账号创建额外 agent，并在成功测试后批量添加到所有可用账号。
- 调整有效账号上限、默认 Agent 列表、默认 Agent 系统提示词、system 消息处理方式。

## API 调用

使用 `.env` 里的 `ALMMA_SERVICE_API_KEY`：

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer svc-your-stable-key"
```

Chat Completions：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer svc-your-stable-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Azure-Anthropic/claude-opus-4-5",
    "messages": [
      { "role": "system", "content": "请简洁回答。" },
      { "role": "user", "content": "你好" }
    ],
    "stream": false
  }'
```

## system 角色兼容

上游 Almma Agents API 只允许一条 `system` 消息，并且必须是消息数组第一条。多条 `system` 或中间插入 `system` 会触发类似错误：

```text
System messages are only permitted as the first passed message.
```

所以本代理默认保留消息头部连续的 `system`/`developer`，并合并成第一条 `system`；一旦遇到第一条 `user` 或 `assistant`，后续再出现的 `system`/`developer` 都转成带标记的 `user` 消息，避免上游顺序错误。

默认配置：

```json
"proxy": {
  "systemMessageMode": "leading_system_convert_rest",
  "systemMarker": "### SYSTEM",
  "developerMarker": "### DEVELOPER"
}
```

可选模式：

- `leading_system_convert_rest`：默认。合并头部连续 system/developer 为第一条 system；后续 system/developer 转成 user 标记文本。
- `merge_system_to_first`：合并所有 system/developer 为第一条 system。
- `keep_first_system_convert_rest`：只保留第 0 条 system，后续 system/developer 转成 user 标记文本。

## 状态与限额

状态文件默认在：

```text
data/state.json
```

管理页保存的运行时设置也在这个文件里，包括：

- 有效账号上限。
- 自动补齐账号池开关。
- 默认 Agent 系统提示词。
- 默认 Agent 列表。
- system 消息处理模式。
- 上游 `/api/models` 模型列表缓存，默认缓存 24 小时。

每个后台账号 key 记录：

- `calls`
- `limit`
- `expiresAt`
- `status`
- `disabledReason`

当当天 `calls >= 500` 时，该账号当天不再参与请求路由；北京时间 `08:00` 后自动清零恢复。`expiresAt` 已过期时，该账号会被禁用，不再参与请求路由。

账号/key 有效期优先使用站点接口返回的 trial/subscription 到期时间；如果接口没有返回可解析时间，才回退到 `config.json` 的 `limits.accountKeyTtlDays`，当前是 14 天。

## 安全提醒

`.env` 和 `data/state.json` 都包含可用密钥、账号密码、Almma backend key。不要提交到仓库，不要公开日志。

## 关于 Turnstile secretKey

Cloudflare Turnstile 的 `secretKey` 只能用于服务端调用 `siteverify` 校验客户端 widget 已经生成的 token，不能用来生成 token。Cloudflare 文档也明确把流程分成：

1. 客户端完成 Turnstile challenge 并生成 token。
2. 客户端把 token 发给后端。
3. 后端用 `secret + response` 调 `siteverify` 校验。

生产 secret 也不会接受测试 dummy token。只有 Cloudflare 提供的测试 sitekey/secret 组合能用于开发测试，不能绕过生产站点的 Turnstile。

如果你能修改 Almma 后端，真正干净的无浏览器方案不是“用 secretKey 兑换”，而是增加内部受保护的账号创建接口，或在可信内网任务里直接创建用户/API key/agent，绕开公开注册接口的 Turnstile。
