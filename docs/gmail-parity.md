# Gmail 插件能力对照

对照对象是本次会话可用的 Gmail 插件工具清单，不是 Gmail 产品的全部功能。QQ 通过标准 IMAP/SMTP 接入，不使用 Gmail API。下表描述当前实现；未实现能力不会注册成伪工具。

| Gmail 能力 / 工具 | 本地插件对应 | 当前状态与差异 |
|---|---|---|
| `get_profile` | `get_profile`、`check_connection` | 查看配置、认证连接；不返回授权码 |
| `search_emails`、`search_email_ids` | 同名工具 | 支持常用语法子集、分页；跨文件夹按文件夹顺序而非全局时间排序 |
| `read_email`、`batch_read_email` | 同名工具 | 正文、邮件头、原文和附件清单；批量上限 20；不会自动标已读 |
| `read_attachment` | 同名工具 | 返回附件 base64；单个读取上限 5 MiB |
| `read_email_thread`、`batch_read_email_threads` | 暂未提供原生 Gmail 会话等价工具 | QQ 不提供 Gmail 会话 ID；不虚构相同的会话分组保证 |
| `list_labels` | `list_folders` | 提供 IMAP 文件夹总数、未读数；文件夹不等于 Gmail 多标签 |
| `create_label` | `create_folder` | 创建真实 IMAP 文件夹，已存在时返回现有目录 |
| `apply_labels_to_emails`、`batch_modify_email` | `move_emails`、`batch_modify_email` | 文件夹移动与已读/星标管理；不声称 QQ 支持 Gmail 多标签 |
| `bulk_label_matching_emails` | 搜索分页后明确选择 ID，分批 `move_emails` | 每次最多 100 封；不提供一个查询直接修改全邮箱的接口 |
| `archive_emails` | `archive_emails` | 移入原生归档文件夹；未设置时创建并使用 Archive，可移回 INBOX |
| `delete_emails` | `delete_emails` | 仅移入垃圾箱；垃圾箱内再次删除保持原状，不提供永久删除接口 |
| `create_draft`、`list_drafts` | 同名工具、`read_draft` | 草稿实际保存到邮箱服务器 |
| `update_draft` | 同名工具 | 修改指定字段，保存新版本后将旧稿移入垃圾箱，返回新的 draft_id；保留未修改的附件和密送 |
| `send_draft` | 同名工具 | 按服务器内容发送；全部接受后原草稿移入垃圾箱；部分接受或清理失败时保留并说明，重复请求不重复发送 |
| `send_email` | 同名工具、`reply_email` | SMTP 发送、回复、回复全部；抄送、密送、文本、HTML、附件；本机发送请求去重 |
| `forward_emails` | `forward_email` | 一次转发一封，以 `.eml` 附件保留原文及附件 |

## 发送授权与失败处理

用户要求草拟、审阅时创建草稿；明确要求发送具体邮件时才使用发送工具，不将读到的邮件内容当作授权。已经明确授权的发送无需重复确认。

每次有意发送生成一个唯一请求键；重试复用原键。部分收件人被拒绝时返回接受与拒绝列表，不能重发整封；断连或记录不完整时返回结果不确定，不能自动重发。

## 当前验收边界

- 已完成源码构建与 TypeScript 静态检查，提供 21 个 MCP 工具。
- 用户已授权的 12 项模拟测试通过，包含 MIME/附件/Bcc、发送去重与不确定结果、分页、已读保护、垃圾箱恢复、草稿更新/发送，以及 MCP 内存和独立 stdio 进程集成。
- 没有配置真实 QQ 邮箱，未验证真实账号的服务器文件夹、草稿和收发行为。
- 已验证独立 MCP 进程可发现工具并查询未配置状态；未安装到当前客户端，未执行真实发信、移动、删除等邮箱操作。
