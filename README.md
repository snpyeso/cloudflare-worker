# Vertex API Cloudflare Worker

精简版 Vertex AI 接口转发器，只保留 OpenAI/Anthropic 请求格式到 Vertex Gemini 的转换，不包含登录、Web UI、SQLite 配置库。

## 接口

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/messages`

访问 token 通过 Cloudflare Secret/环境变量 `API_TOKEN` 固定。

```text
API_TOKEN=your-api-token
```

请求时使用：

```bash
Authorization: Bearer your-api-token
```

Anthropic 客户端也可以使用：

```bash
x-api-key: your-api-token
```

## Cloudflare Pages 连接 GitHub

这个仓库默认支持 Cloudflare Pages 部署，部署后可以使用 `*.pages.dev` 域名。

Cloudflare Pages 构建设置：

```text
Build command:
npm run deploy

Build output directory:
dist
```

`npm run deploy` 这里只负责生成 Pages 输出文件，不会调用 `wrangler deploy`，因此不需要 `CLOUDFLARE_API_TOKEN`。

在 Pages 项目的 `Settings` -> `Environment variables` 里添加运行时变量：

```text
API_TOKEN=your-api-token
VERTEX_SERVICE_ACCOUNT_JSON=完整 Google 服务账号 JSON
```

可选：

```text
VERTEX_LOCATION=global
VERTEX_MODELS=gemini-2.5-flash,gemini-2.5-pro,gemini-3.1-pro-preview
```

部署后 base URL：

```text
https://你的-pages项目.pages.dev/v1
```

## Worker CLI 部署方式

Windows PowerShell 里执行：

```powershell
cd C:\Users\Axzo\Documents\cloudflare-worker
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

脚本会自动：

- 安装依赖
- 检查/打开 Cloudflare 登录
- 让你输入 Google 服务账号 JSON 文件路径
- 上传 `VERTEX_SERVICE_ACCOUNT_JSON`
- 部署 Worker

部署完成后，把客户端 base URL 设置成：

```text
https://你的-worker地址/v1
```

## 不想用 CLI 的方式

可以生成单文件 Worker：

```powershell
cd C:\Users\Axzo\Documents\cloudflare-worker
powershell -ExecutionPolicy Bypass -File .\scripts\bundle.ps1
```

生成文件：

```text
dist/worker.js
```

然后去 Cloudflare 后台：

`Workers & Pages` -> `Create Worker` -> `Edit code`

把 `dist/worker.js` 的内容粘贴进去。

之后在 Worker 的 `Settings` -> `Variables and Secrets` 里添加：

- `VERTEX_SERVICE_ACCOUNT_JSON`，类型选 Secret，值填完整服务账号 JSON
- `API_TOKEN`，必填，类型建议选 Secret
- `VERTEX_MODELS`，可选，例如 `gemini-2.5-flash,gemini-2.5-pro,gemini-3.1-pro-preview`
- `VERTEX_LOCATION`，可选，默认 `global`

## Cloudflare Secrets

推荐直接放完整服务账号 JSON：

```bash
npx wrangler secret put VERTEX_SERVICE_ACCOUNT_JSON
```

或者分别设置：

```bash
npx wrangler secret put VERTEX_PROJECT_ID
npx wrangler secret put VERTEX_CLIENT_EMAIL
npx wrangler secret put VERTEX_PRIVATE_KEY
```

可选配置：

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put VERTEX_MODELS
npx wrangler secret put VERTEX_LOCATION
```

`VERTEX_MODELS` 使用逗号分隔，例如：

```text
gemini-2.5-flash,gemini-2.5-pro,gemini-3.1-pro-preview
```

## 本地运行

复制本地环境变量模板：

```bash
cp .dev.vars.example .dev.vars
```

安装并启动：

```bash
npm install
npm run dev
```

## 手动部署

```bash
npm install
npm run deploy:worker
```

部署后把客户端 base URL 改成 Worker 地址即可，例如：

```text
https://vertex-api-worker.<your-subdomain>.workers.dev/v1
```

## Worker 连接 GitHub

如果你是 Worker 项目而不是 Pages 项目，构建设置里需要填写：

```bash
npm run deploy:worker
```

或者：

```bash
npx wrangler deploy --config wrangler.worker.toml
```

Worker GitHub 构建需要 `CLOUDFLARE_API_TOKEN`。如果你使用 Pages 项目和 `*.pages.dev` 域名，请使用上面的 Cloudflare Pages 配置。

## 注意

Cloudflare Worker 是无状态环境。本项目会尽量在响应里保留 Gemini 的 `thought_signature`，并在同一个 Worker isolate 内做短期缓存；但如果客户端完全丢弃工具调用扩展字段，且 Worker isolate 被切换，复杂多轮工具调用仍可能触发 Vertex 对 `thought_signature` 的校验问题。
