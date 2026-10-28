# 通用邮箱插件

本地 stdio MCP 插件，预置 QQ 邮箱，通过 IMAP/SMTP 连接邮箱。提供 21 个工具，覆盖搜索、读信、附件、草稿、发送、回复、转发、文件夹、已读/星标、归档和移入垃圾箱；以 Gmail 插件为功能对照，具体差异见[能力对照](docs/gmail-parity.md)。

授权码由本机读取，插件本身不托管云端服务。首次配置不需要把授权码发到聊天里。

## 快速开始

需要 Node.js 22 或更高版本。在项目目录运行：

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run configure
```

配置向导在终端收集邮箱地址和授权码，授权码输入不回显。默认配置位于 `~/.config/qq-mail/config.json`；设置 `XDG_CONFIG_HOME` 时遵循该目录。授权码保存在配置目录内独立的 `600` 权限文件中，更新配置时保留原配置备份。

配置完成后可自行检查连接：

```sh
node dist/mail-cli.cjs status
node dist/mail-cli.cjs check-connection
```

`status` 只查看配置；`check-connection` 验证 IMAP 和 SMTP 认证，不发测试邮件。

## 配置 QQ 邮箱

1. 登录 QQ 邮箱网页版，进入「设置 → 账号与安全 → 安全设置」。
2. 开启 POP3/IMAP/SMTP 服务，生成第三方客户端授权码。
3. 在本机配置向导中填写完整邮箱地址和 16 位授权码。

QQ 预设使用 `imap.qq.com:993` 和 `smtp.qq.com:465`，均要求 TLS 及有效服务器证书。使用授权码，不使用 QQ 登录密码。更改账号密码可能使原授权码失效。以 [QQ 邮箱官方说明](https://help.mail.qq.com/detail/106/985)为准。

也可自行保存 [QQ 配置示例](examples/config.qq.json)，通过 `MAIL_CONFIG_PATH` 指定其绝对路径，并在运行 MCP 服务的环境中设置 `QQ_MAIL_AUTH_CODE`。`MAIL_EMAIL` 和 `MAIL_AUTH_CODE` 可覆盖邮箱地址及凭据；本插件不会自动加载项目 `.env`。

桌面客户端不一定继承终端环境变量，推荐使用配置向导保存的本机文件。支持在配置的 `auth.passwordFile` 中填写相对于配置文件目录的路径；不要将实际凭据放入项目或 MCP 调用参数。

## 接入客户端

通用 MCP 客户端配置参考 [mcp-client.json](examples/mcp-client.json)，将路径替换为本机实际的绝对路径：

```json
{
  "mcpServers": {
    "qq-mail": {
      "command": "node",
      "args": ["/absolute/path/to/qq-mail/dist/mail-server.cjs"],
      "env": { "MAIL_CONFIG_PATH": "/absolute/path/to/config.json" }
    }
  }
}
```

使用默认配置位置时可省略 `env`。客户端若找不到 `node`，将 `command` 改为本机 Node.js 可执行文件的绝对路径。

Codex 插件包使用根目录的 `plugin.json`、`mcp.json` 和 `skills/`，遵循[官方便携插件格式](https://developers.openai.com/plugins/build/plugins)。本地市场清单示例为 [codex-marketplace.json](examples/codex-marketplace.json)；在插件目录的 `.agents/plugins/marketplace.json` 中使用它，`source.path` 相对于项目根目录。按客户端支持的市场注册与安装流程加载。源码目录先构建再安装，发布包已包含构建产物。

此仓库不会自动修改客户端的全局配置，也不自动安装插件。只支持远程 HTTP MCP 的客户端不能直接启动此本地插件。

Claude Code 也附带原生插件描述文件，可用 `claude --plugin-dir /absolute/path/to/qq-mail` 加载；其他客户端使用上述通用 MCP 配置。

## 其他邮箱

将 `provider` 设为 `custom`，提供 IMAP、SMTP 主机、端口和 `security`，参考[自定义邮箱示例](examples/config.custom.json)。加密方式为 `tls` 或强制升级的 `starttls`，不提供明文降级或关闭证书校验的选项。当前采用密码或应用授权码认证，不实现 Google、微软 OAuth 登录。

文件夹优先从服务器用途标记中识别；服务商未标记时，在配置的 `folders` 中指定真实路径。先调用 `list_folders` 获取路径。一个配置对应一个账号，可在客户端配置多个 MCP 进程并各自指定不同配置文件。

## 查询语法

支持关键词、引号短语、负号排除，以及以下 AND 条件：

- `from:`、`to:`、`cc:`、`bcc:`、`subject:`、`body:`；地址条件支持 `me`。
- `after:2026-10-01`、`before:2026-11-01`、`newer_than:7d` 或 `newer_than:2w`。
- `is:unread`、`is:read`、`is:starred`、`is:unstarred`、`has:attachment`。
- `in:inbox`、`in:sent`、`in:anywhere`、`label:"文件夹路径"`、`-in:trash`。
- `larger:1M`、`smaller:100K`，大小单位为二进制字节倍数。

`label:` 在此表示一个 IMAP 文件夹。OR、括号、Gmail 分类等未支持语法会报错，不会忽略条件。日期按 IMAP 的日粒度和服务器日期语义匹配，`after:` 使用 IMAP SINCE（含当天），并非逐秒复制 Gmail 搜索语义。

默认搜索除垃圾邮件和垃圾箱外的文件夹。结果按 INBOX 优先、随后文件夹路径排序，各文件夹内 UID 倒序；不是跨文件夹的全局时间排序。分页必须保留原查询和 `next_page_token`，直到标记为空。每页最多 100 个结果，每次最多检查 1000 个候选；未完成时返回下一页标记。`scanned_count` 不是总匹配数。

## 邮件与附件

读取不会将邮件标为已读。完整邮件最多读取 20 MiB，正文和 HTML 各返回最多 120000 字符，截断会显式标注；原文格式最多返回 2 MiB。附件读取上限为单个 5 MiB，base64 返回；发送附件单个上限 10 MiB，整封编码后不超过 20 MiB。

发送支持收件人、抄送、密送、纯文本、HTML 和附件；附件使用显式 base64 内容，不读取任意本机文件或远程 URL。转发以 `.eml` 附件保留原邮件及附件。

草稿保存在邮箱服务器。`update_draft` 仅修改给出的字段，附件未给出时保留，`attachments:[]` 清空附件；提供 `text` 或 `html` 时替换正文版本，避免保留过时的另一版本。先保存新稿，再将旧稿移入垃圾箱，返回的新 `draft_id` 用于后续操作。`send_draft` 全部接受后将原稿移入垃圾箱，部分接受或清理失败时保留原稿并明确报告。

每次有意发送提供唯一 `idempotency_key`，重试同一发送时复用。发送记录保存在本机配置目录下的 `state/deliveries/`，仅保存请求指纹和发送结果，不保存正文或附件。返回 `DELIVERY_UNKNOWN` 时先核对邮箱，不要自动更换请求键重发。SMTP 接受不保证最终投递成功；已发送副本是否由服务器保存取决于邮箱服务商。

## 邮件管理

`create_folder` 创建目录；`move_emails` 移动明确选择的邮件；`batch_modify_email` 修改已读与星标。移动后使用返回的新 ID，或重新搜索，避免使用原文件夹的旧 ID。

`archive_emails` 优先使用配置的 `folders.archive` 或服务器标记的目录；不存在时创建并使用普通 `Archive` 文件夹。`delete_emails` 只移入垃圾箱，重复删除垃圾箱邮件不会永久清除。需要恢复时用 `move_emails` 移回 `INBOX` 等目录。服务器不支持安全的定向移动时会拒绝移动，而不是清理整个文件夹。批量操作逐封报告成功和错误，应检查 `complete` 与 `results`，不得把部分成功当作全部完成。

QQ 以文件夹组织邮件，不提供 Gmail 的一封邮件同时打多个标签、原生 Gmail 会话 ID 或分类语义。批量整理先搜索并明确选择 ID，每次最多处理 100 封。

## 开发与打包

```sh
npm run check
npm test
npm run build
npm run package
```

发布包位于 `releases/qq-mail-0.1.0.tar.gz`，包含独立运行的 MCP/配置工具、插件清单、技能和使用文档。无需在使用发布包时安装 npm 依赖。`dist/THIRD_PARTY_NOTICES.txt` 包含所打包运行时依赖的许可声明。

本次已获用户许可，12 项模拟单元测试和 MCP 集成测试通过，包括独立构建产物的 stdio 启动与工具发现。测试不登录真实邮箱、不发送真实邮件；真实 QQ 服务端的文件夹、草稿和收发行为仍需在本机配置账号后验收。
