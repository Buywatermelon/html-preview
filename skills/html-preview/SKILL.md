---
name: html-preview
description: >-
  生成或修改供用户预览的 HTML、报告或静态站后，自动归类上传到个人私有空间「我的」，返回在线预览链接；按用户要求开启或撤回单页免登录公开分享链接。
  Use after creating or updating HTML deliverables, including answer-me-with-html reports.
---

# html-preview

HTML 交付默认归类上传到个人私有空间「我的」（包含 `answer-me-with-html` 报告），返回的 `/p/...` 预览链接仅本人登录工作台后可访问。仅当用户明确需要对外免登录分享某个页面时，运行 `html-preview share` 交付公开链接 `shareUrl`（`/s/<token>/`）；用户要求撤回外链时运行 `html-preview unshare`。用户明确要求仅本地时跳过。

## 常规上传与目录内排序

```bash
# 首次上传到个人私有空间「我的」并指定项目与任务
html-preview upload ./outputs/report.html --project '示例项目' --task '示例任务'

# 后续同文件直接续传新版本
html-preview upload ./outputs/report.html
```

有全局命令时直接使用；否则运行本 Skill 随包的 `python3 scripts/html-preview.py`。Python 3.9+，无需安装依赖。

- 已绑定文件直接追加版本，不先查目录；绑定按服务地址与成员保存在最近 `.html-preview.json` 的 `files` 中。
- 新文件沿用当前项目在该服务的默认分类，自动生成标识并读取 `<title>`。
- 返回 `needs_destination`（退出码 2）时，从 `/api/catalog` 返回的真实项目/任务列表选择，带 `--project '项目' --task '任务'` 重跑。新分类随上传自动建立，无空目录。
- 同一目录按标题编号自然排序，例如 `01` 在 `02` 前、`02` 在 `10` 前。
- 同一页面覆写原输出路径以便续版本。文件改名时上传传原 `--name` 和当前归属。

打开成功返回的 `url` 检查后交付在线链接。`versionUrl` 固定本次版本。私有预览链接（`/p/...`）仅本人登录工作台后可访问。

## 单页公开分享与撤回（`share` / `unshare`）

```bash
# 开启或获取单页免登录公开分享链接（幂等，支持本地路径、--name 或 --id 三选一）
html-preview share ./outputs/report.html
html-preview share --name report-page

# 取消公开分享（原公开链接立即返回 404）
html-preview unshare ./outputs/report.html
```

- **默认私有、按需公开**：不要在未获要求时自动开启公开分享；当用户明确要求“发给别人看”“生成免登录外链”或“公开分享”时，运行 `share` 并向用户展示返回的 `shareUrl`（形如 `https://.../s/<token>/`）。
- **自动跟随最新版本**：公开链接 `/s/<token>/` 始终渲染该页面的**最新版本**（不暴露历史草稿版本）。后续继续 `html-preview upload` 更新同一页面时，已发出的 `shareUrl` 刷新即见最新版，且 `.html-preview.json` 中的 `shareUrl` 会自动保留。
- **幂等与撤销轮换**：对已公开页面重复执行 `share` 返回同一个 `shareUrl`；执行 `unshare` 后清空公开令牌并移除本地绑定中的 `shareUrl`，原链接立即返回 `404`（之后若重新 `share` 将签发全新随机 token）。

## 改已有页面

```bash
html-preview edit ./outputs/report.html --title '新标题'
html-preview edit ./outputs/report.html --project '示例项目' --task '目录'
html-preview delete ./outputs/report.html --dry-run
html-preview delete ./outputs/report.html --yes
```

`edit` 改标题或目录。本地绑定仍是同一个 id 和 name，之后 `upload` 续版本。排序靠标题编号。`delete` 删除个人空间中的指定页面；没有 `--yes` 不会删。

## 页面双向对话、ACP 会话与回填（`bind` / `--bind` / `--resolves` / `reply` / `session`）

网页是第一操作入口，本机 `daemon` 作为标准 ACP v1 客户端与 coding agent 通信，网页通过 `/api/events` 实时查看全量会话轨迹（历史消息、工具调用、流式输出、取消与权限审批），并提供两个核心动作：
- **传话给原会话**：发送按钮始终可用。若后续用户在网页上要求继续改 HTML、直接在仓库落地实现，或委派另一个 coding agent 执行，页面不会提供额外派工按钮——原会话直接收到带页面/选区锚点的消息（及 `HTML_PREVIEW_INTERACTION_ID`），自行修改并续传 `--resolves`、直接改代码，或按本机 skill/子代理拆分派工后回报结果。
- **临时提问**：零配置开启独立只读会话（优先级 `codex` → `agy` → `claude`，原宿主机离线自动回退其他在线机器），不污染原会话、不修改页面。

纯 API 命令（如普通 `upload`、`projects`、`catalog`、`versions`、`share`、`unshare`、`edit`、`delete`）保持无状态，不依赖本机守护进程。所有交互类命令（`bind`、`upload --bind`、`upload --resolves`、`reply`、`session`、`daemon drain`）强制依赖本机 `daemon`：检测未运行时自动拉起，拉起失败直接报错退出并提示修复方式（不做静默降级）。

```bash
# 上传并同时绑定本机守护进程与当前会话（或对已有页面执行 bind 回填）
html-preview upload ./outputs/report.html --bind
html-preview bind ./outputs/report.html

# 响应网页消息修改 HTML 后续传新版本，附带 --resolves 关联该条交互记录
html-preview upload ./outputs/report.html --resolves int_xxx

# 发送结构化文字回复（如回报代码实现或委派结果，可与新版本上传并存）
html-preview reply int_xxx --text '已完成修改并校对口径'

# 在终端协作重入非共享会话（Claude / agy），与本机 daemon 共用同一把 OS session 互斥锁
html-preview session agy --conversation <session-id>
html-preview session claude --resume <session-id>
```

终端与网页同时访问同一原会话时：支持共享执行器的 Agent（Codex 共享 `app-server`、Grok 共享 `--leader`）自动附着双向同步；独立终端占用时网页消息先持久入队并实时旁观，支持等待终端自然退出自动送达，或在网页点击「由网页接管 / 本轮结束后接管」温和移交写入权。对未绑定的历史页面也可直接在右侧面板（快捷键 `⌘I` / `Ctrl+I`）发起消息，在线守护进程会自动建立会话绑定。

## CLI 设备登录与本机守护进程（`login` / `daemon`）

```bash
# 在终端发起 RFC 8628 设备码登录（默认安装并自启本机 daemon；CI=true 或传 --no-daemon 时仅跳过登录期安装）
html-preview login https://html.1997117.xyz

# 查看、拉取待处理评论或管理本机常驻守护进程
html-preview daemon status
html-preview daemon drain
html-preview daemon logs
```

1. **GitHub 登录工作台**：浏览器通过 GitHub OAuth 登录个人工作台。
2. **CLI 设备授权流程**：运行 `html-preview login <URL>` 获取验证链接与 `XXXX-XXXX` 短码，在任意已登录 GitHub 的桌面或手机浏览器打开 `<URL>/dashboard?device_code=XXXX-XXXX` 点击「批准设备登录」（或在工作台左下角个人菜单「设备与 CLI 令牌」中输入短码确认）。独立设备令牌保存在 `${XDG_CONFIG_HOME:-~/.config}/html-preview/credentials.json`（权限 `0600`），可随时在工作台单独吊销。
3. **CI 与环境变量令牌**：无头环境或 CI 可在「设备与 CLI 令牌」中点击「新建 CI 令牌 (HTML_PREVIEW_TOKEN)」生成一次性令牌，并通过环境变量 `HTML_PREVIEW_TOKEN` 传入。
4. **服务地址优先级**：`--url` / `--base-url` → `HTML_PREVIEW_URL` → 最近 `.html-preview.json` → 默认服务（`https://html.1997117.xyz`）。

输入支持 HTML、ZIP 或含根 `index.html` 的目录，上限 20 MiB、500 文件。失败保留本地产物；超时用错误中的 name 执行 `versions <name>` 确认后再重传。
