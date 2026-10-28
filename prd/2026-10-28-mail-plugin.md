# PRD：通用邮箱插件

- Status: Ready for implementation
- Created: 2026-10-28
- Updated: 2026-10-29
- Owner / requester: 用户
- Source request: 创建一个通用插件，支持配置 QQ 邮箱。
- Product Authority: Confirmed Product Decisions section

## Requester Review Summary

- 已确认：本地通用 MCP 插件，配置 QQ 邮箱，邮箱授权码留在本机，功能对标当前 Gmail 插件。
- Gmail 对标能力：搜索、读信、附件、草稿、发送、回复、转发、邮件管理及组织。
- 重要例外：Gmail 的多标签和会话模型不等同于 QQ 原生 IMAP 文件夹，按已确认的 QQ 原生能力对齐。
- 实施前需确认：无阻塞的产品问题。
- 状态原因：用户已确认本地运行、Gmail 对标范围及 QQ 原生组织方式。

## 1. Background And Product Intent

用户希望通过可复用插件配置和使用 QQ 邮箱，避免每次在聊天中重复提供服务器参数。

## 2. Goals And Success Criteria

安装目标客户端后，用户可完成邮箱配置，并使用已确认范围内的邮件能力；配置失败时获得可操作的错误提示。

## 3. Users And Usage Context

使用支持本地 stdio MCP 的 AI 客户端处理邮箱的用户，包括 Codex、Claude Code 等。

## 4. Scope

### In Scope

- 通用插件与 QQ 邮箱配置能力。
- 已确认采用本地通用 MCP；通过 IMAP/SMTP 适配 QQ 邮箱。
- 功能以当前可用 Gmail 插件工具清单为对标；各项能力与差异见 `docs/gmail-parity.md`。

### Out Of Scope

云端部署不在此次本地插件范围内。定时发送、多账号、Google Workspace 分类规则不由“对标 Gmail 插件”推定授权；永久删除不在候选首版范围内。

## 5. Core User Journey

安装插件 → 在本机配置邮箱地址及授权码 → 检查连接 → 查询和阅读邮件 → 按需保存草稿供审阅 → 根据用户明确发送指令发送。

## 6. Interaction And Information Design

采用客户端内工具调用；邮箱授权码通过本机终端配置向导或环境变量输入，不要求用户在聊天中发送。向导将授权码保存为本机独立文件，并限制文件权限。

## 7. Product Rules And State Logic

- QQ 邮箱使用其专用授权码登录第三方客户端。
- 发信遵循 Gmail 插件的明确授权原则；需审阅时先创建草稿，已有明确发送指令时不重复索取授权。
- 凭据仅由本机运行进程读取，工具返回值不包含凭据。
- QQ 使用文件夹、已读和星标对齐组织能力；删除仅移入垃圾箱，不提供永久删除接口。
- 更新草稿先保存新版本，再把旧版本移入垃圾箱；全部发送成功后尝试把原草稿移入垃圾箱，清理失败不影响“已发送”的事实。

## 8. Edge Cases, Errors, And Recovery

候选处理：未配置、配置缺失、授权码失效、服务未开启、连接超时、邮件不存在；明确区分“发送成功”和“无法确认发送结果”，避免自动重发导致重复邮件。

## 9. Content And Terminology

“授权码”指 QQ 邮箱为第三方客户端生成的专用密码，不是 QQ 登录密码。“草稿”与 Gmail 对标，实际保存在邮箱服务器草稿箱。

## 10. Acceptance Criteria

- 给定合法 QQ 邮箱配置，用户能启动插件并查看配置状态，输出不包含授权码。
- 给定缺失或失效配置，用户获得对应错误及修复提示。
- 搜索和读信不会自动将邮件标为已读；附件内容只在读取附件时返回。
- 草稿保存在邮箱服务器；直接发送、回复、转发只在明确用户授权后使用。
- 同一发信请求重试复用请求键，已接受或结果不确定时不能自动再次投递。
- 选定邮件可修改已读和星标，可移动和归档；旧邮件 ID 失效时明确报错。
- 删除仅将选定邮件移入垃圾箱；对垃圾箱中的邮件再次删除不会永久清除。
- 服务器不支持安全定向移动时停止操作，不触发可能影响其他邮件的全文件夹清理。
- 更新草稿时保留未修改的收件人、密送及附件；新草稿保存成功而旧草稿清理失败时明确报告部分结果。

## 11. Review Checklist And Sign-off Questions

1. 已确认使用 QQ 原生文件夹、已读和星标，对应 Gmail 组织能力，删除仅移入垃圾箱。

## Confirmed Product Decisions

> PROTECTED USER-AUTHORITY SECTION
> Rows in this section MUST NOT be created, modified, deleted, reinterpreted,
> or superseded without explicit user approval for that specific decision change.
> Agent self-approval is forbidden.

| ID | Confirmed Decision | Must Do | Must Not Do | Rationale | Violation Signal | Confirmation | Status |
|---|---|---|---|---|---|---|---|
| PD1 | 创建通用插件，支持配置 QQ 邮箱 | 提供可复用插件及 QQ 邮箱配置能力 | 不得以仅有说明文档替代最终插件交付 | 用户需要实际插件 | 交付物没有插件或不支持 QQ 邮箱配置 | user-confirmed-direct: 用户原话“创建一个通用插件，支持配置 qq 邮箱” | active |
| PD2 | 使用本地通用 MCP 插件，邮箱授权码保存在本机 | 支持本地 MCP 客户端；本机读取邮箱凭据 | 不得改为云端保存邮箱授权码 | 用户选择本地方案 | 运行或凭据依赖云端托管服务 | user-confirmed-direct: 用户对运行方式问题选择“本地通用 MCP 插件（推荐）”，问题明确说明可供 Codex、Claude Code 等客户端共用且授权码保存在本机 | active |
| PD3 | 功能对标 Gmail 插件 | 以当前 Gmail 插件工具清单作为功能对照依据 | 不得把“对标”解释成 QQ 原生支持所有 Gmail 特有语义 | 用户需要熟悉的邮件处理能力 | 功能清单未与 Gmail 对照或隐瞒兼容差异 | user-confirmed-direct: 用户对首版邮件能力问题回答“对标 google mail 插件” | active |
| PD4 | 按 QQ 原生能力对齐 Gmail：原生文件夹、已读与星标管理，其余常规邮件能力照做，删除仅移入垃圾箱 | 提供可恢复的邮件组织与垃圾箱操作；明确会话及多标签差异 | 不得伪装 Gmail 多标签或原生会话 ID；不得实现永久删信接口 | 用户接受服务商能力差异 | 不可恢复删除，或声称 QQ 具备 Gmail 原生标签/会话语义 | user-confirmed-direct: 用户对包含完整范围与删除语义的问题回答“按 QQ 原生能力对齐（推荐）” | active |

## 12. Open Questions And Risks

- QQ 不提供 Gmail 原生会话 ID、多标签及分类；这些差异已获用户确认，具体能力见对照表。
- 通用采用标准 MCP 和可配置 IMAP/SMTP；多账号能力未由用户明确要求。
- 尚未连接真实 QQ 邮箱，真实服务端行为需要用户在本机配置后验收。

## 13. Implementation Notes

- 不把授权码打包、提交或写入日志。
- 官方 QQ 邮箱授权码说明：<https://help.mail.qq.com/detail/106/985>。
- 插件包格式依据：<https://developers.openai.com/plugins/build/plugins>。
- 本文候选方案不构成对未确认产品决策的授权。
- 2026-10-29：用户明确允许模拟单元测试与本地 MCP 集成测试，不登录真实邮箱、不发送真实邮件。
- 2026-10-29：用户要求新建公开 GitHub 仓库，允许依该问题上下文初始化默认分支；仓库名沿用项目名 `plugin-qq-mail`。
