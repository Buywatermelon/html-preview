# html-preview

个人 HTML 预览。每个成员有自己的工作台「我的」（项目 → 任务 → HTML）。页面默认私有，地址是 `/p/...`，要登录。需要对人打开时，给单页一个公开链接 `/s/<token>/`，免登录，只出最新版。

浏览器登录用 GitHub OAuth。CLI 用设备码在已登录的浏览器里批准。普通上传不需要本机守护进程；和 coding agent 会话互通时需要。

线上：`https://html.1997117.xyz`

## 开发

Node 24，Python 3.9+。

```bash
npm ci
cp .env.example .env
cp .dev.vars.example .dev.vars
npm run check
python3 -m unittest discover -s test -p '*_test.py'
npm run build
```

`npm run dev` 起本地 Worker。`npm run build:node` 之后，`npm run dev:node` 起 Node 服务。

## 部署

推 `main` 时 GitHub Actions 检查并部署 Cloudflare。部署前用已有的 `CLOUDFLARE_ACCOUNT_ID` 写成 R2 端点，用仓库所有者登录名写入 `ADMIN_GITHUB_LOGIN`。D1 `database_id` 仍在 `wrangler.toml`。GitHub OAuth 和 S3 密钥是 Worker secret，不进 Git。

本机走同一条部署：

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export ADMIN_GITHUB_LOGIN=...
npm run deploy
```

自托管：填好 `.env.example` 里的 `PUBLIC_BASE_URL`、GitHub OAuth 和 S3，然后 `docker compose up -d --build`。元数据在 SQLite 卷，文件在配置的桶。

## CLI

命令在 `skills/html-preview/`。复制到别的机器前先 `npm run build:skill`。

```bash
html-preview login https://html.1997117.xyz
html-preview upload ./report.html --project '示例项目' --task '示例任务'
html-preview share ./report.html
```
