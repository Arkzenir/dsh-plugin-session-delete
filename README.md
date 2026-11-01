# dsh-plugin-session-delete

English | [中文](#中文)

Frustrated that sessions can't be deleted from the web client? Bothered that archiving only hides a conversation? Ever corrupted a session while editing the harness and found no way to remove it? This plugin has your back.

**Delete sessions properly from the DeepSeek Harness UI.** A red "Delete session" row joins the sidebar session-row "..." menu and a trash button sits in the conversation header; either opens a risk-consent dialog whose confirm button stays disabled until you tick "I understand the consequences". On confirm the session log, projection cache and workspace accounting are removed, and a running session is stopped first.

**An agent tool is included too:** `workbench_session_delete`.

Compatible with DeepSeek Harness **0.2.x** (`engines.dsh: ^0.2.1-rc.5`); works in the web GUI and the desktop client alike.

## Installation

```sh
dsh plugin --profile <profile> add <absolute path to this package>
# from the repository:
dsh plugin --profile desktop add github:Arkzenir/dsh-plugin-session-delete
```

Restart the profile to apply.

## Features

- **Sidebar "Delete session" row** — registered in the `sidebar.workspaces.session.menu.item` slot (order 500, after pin/rename/fork/archive), styled as a danger item with a separator. Opening it never switches the active conversation.
- **Header trash button** — registered in the `conversation.session.header.actions` slot (order 30); its tooltip reflects the running state.
- **Risk-consent dialog** — rendered through `shell.overlay`, showing the session title and id; the destructive action is enabled only after the acknowledgement checkbox is ticked.
- **Delete chain** (host side, keeping memory and disk consistent):
  1. cancel a running agent and wait for quiescence;
  2. flush the live session and detach it from the session store, so a dispose-time drain cannot recreate the log directory;
  3. remove the persisted log directory `<sessions root>/<project dir>/<session id>/`, for both id spellings (raw uuid and the `session-` prefixed form), with the root read from the live persistence service;
  4. drop the projection-cache row (`session_projcache` domain, `sessions` table);
  5. only once the log is confirmed gone, clear workspace accounting (membership, archive set, pin set) through the workspace registry.
- The client list refreshes in place after a delete — no page reload — and if the deleted session was the one on screen, the next remaining session opens automatically.
- Chinese and English copy follows the UI language.

## Compatibility notes

- Since 0.2.x, DSH validates a plugin's `engines.dsh` at install and at startup; this package declares `^0.2.1-rc.5`.
- DSH still has **no official session-delete API** (`dsh-workspace` documents session deletion as an absent capability), so this plugin composes one from the existing public surfaces: `ctx.sessions` flush/detach, the already-open `ctx.storageDomain` domains, the `ctx.workspaceRegistry` accounting API, and an `ctx.webServer` route. Upstream changes to those surfaces may require an update here.

## Roadmap

- Add more session-operation tools and options
- Expose the existing session options to agents as tools

## Changelog

- **v0.4.0 (2026-11-01)**: Ported to DSH 0.2.1-rc.5.
  - Manifest: added `engines.dsh` and `dsh.manifestVersion` (the old `peerDependencies` range is now rejected by the compatibility gate); dropped the stale `dsh.client.inject`.
  - Client: the sidebar row now registers the official `sidebar.workspaces.session.menu.item` slot instead of injecting DOM through a MutationObserver and matching titles; the icon is `IconTrashOutlineRegular`; after a delete the list is refreshed with `sessions.refresh()` and the on-screen session (from `retainedBy.mainView`) is replaced through `uiWorkspace.openSession()`; copy uses the `locale` service `t` seat.
  - Host: the log root comes from the live `sessionPersistence` service (honouring a custom DSH_HOME) and the `--<project>--/<id>/session.vN.jsonl` layout is handled; workspace accounting is written through `workspaceRegistry` (`detachSession`/`unarchiveSession`/`unpinSession`, including the new pin set) instead of writing the domain behind the registry's cache; removed the `sessions.attachments` fallback that no longer exists; added settled retries so a dispose-time directory rewrite cannot survive; removed the `__chameleon/session/list` endpoint the client no longer needs.
- **v0.3.1 (2026-08-14)**: Fixed deleted sessions being left as "Ungrouped" rows after a partial delete; the host now deletes the on-disk log and confirms it before removing workspace accounting.
- **v0.3.0 (2026-08-14)**: Added English adaptation (i18n).

---

<a id="中文"></a>
# 中文

[English](#dsh-plugin-session-delete)

你是否困扰于 web 端无法删除对话？是否觉得归档对话只是隐藏，删除得不够彻底？是否在编辑 harness 时遇到损坏的会话无法删除？这个插件可以帮你。

**在 DeepSeek Harness 界面里彻底删除会话。** 侧栏会话行的 "..." 菜单里新增红色「删除会话」项，会话顶部新增垃圾桶按钮；点击后弹出风险确认弹窗（需勾选「我已了解后果」）。确认后删除会话日志、投影缓存与工作区记账；运行中的会话会先停止再删除。

**同时提供 agent 工具**，让 agent 也能删除会话：工具名 `workbench_session_delete`。

兼容 DeepSeek Harness **0.2.x**（`engines.dsh: ^0.2.1-rc.5`），在 web 与桌面客户端中均可使用。

## 安装

```sh
dsh plugin --profile <profile> add <绝对路径或仓库地址>
# 例（本仓库）：
dsh plugin --profile desktop add github:Arkzenir/dsh-plugin-session-delete
```

重启对应的 profile 生效。

## 功能

- **侧栏「删除会话」菜单项**：注册在 `sidebar.workspaces.session.menu.item` 槽位（order 500，位于置顶/重命名/分支/归档之后），红色危险样式并带分隔线；点击不会切换当前会话。
- **会话头部垃圾桶按钮**：注册在 `conversation.session.header.actions` 槽位（order 30），运行中显示不同提示。
- **风险确认弹窗**：通过 `shell.overlay` 槽位渲染，显示会话标题与 id，勾选确认后「删除」才可点击。
- **删除链路**（主机侧，保持内存与磁盘一致）：
  1. 运行中的 agent 先 `cancel` 并等待静默；
  2. flush 并将会话从会话存储中 detach（避免 dispose 阶段回写重建日志目录）；
  3. 删除磁盘日志目录 `<sessions root>/<项目目录>/<会话 id>/`（覆盖原始 uuid 与 `session-` 前缀两种 id；根目录取自活动 persistence 服务）；
  4. 删除投影缓存行（`session_projcache` 域 `sessions` 表）；
  5. 确认日志已消失后，再通过 workspace registry 清理工作区记账（成员、归档集合、置顶集合）。
- 删除成功后前端原地刷新会话列表，无需刷新页面；若删除的是当前会话，会自动打开下一个会话。
- 中英文文案跟随界面语言。

## 兼容性说明

- 自 0.2.x 起 DSH 会在安装与启动时校验插件声明的 `engines.dsh`，本插件声明 `^0.2.1-rc.5`。
- DSH 至今**没有官方的会话删除 API**（`dsh-workspace` 明确将会话删除列为未提供的能力），因此本插件基于既有的公共接口组合实现：`ctx.sessions` 的 flush/detach、`ctx.storageDomain` 的已打开域、`ctx.workspaceRegistry` 的记账接口、`ctx.webServer` 的自定义路由。若上游改变这些接口，插件可能需要同步调整。

## 后续开发计划

- 添加更多针对会话的操作工具与选项
- 将已有的会话操作选项提供给 agent

## 更新日志

- **v0.4.0（2026-11-01）**：适配 DSH 0.2.1-rc.5。
  - 清单：新增 `engines.dsh` 与 `dsh.manifestVersion`（旧版 `peerDependencies` 在 0.2.x 会被兼容性校验拒绝），移除已不存在的 `dsh.client.inject`。
  - 客户端：侧栏删除项改为注册官方槽位 `sidebar.workspaces.session.menu.item`，不再用 MutationObserver 注入 DOM、也不再按标题匹配会话；图标改为 `IconTrashOutlineRegular`；删除后改用 `sessions.refresh()` 刷新、并按 `retainedBy.mainView` 判断当前会话后用 `uiWorkspace.openSession()` 切到下一个会话；文案改用 `locale` 服务的 `t` 座位。
  - 主机：日志根目录改从活动 `sessionPersistence` 服务读取（兼容自定义 DSH_HOME），适配 `--<项目>--/<id>/session.vN.jsonl` 布局；工作区记账改为通过 `workspaceRegistry` 的 `detachSession`/`unarchiveSession`/`unpinSession` 写入（同时清理新增的置顶集合），避免直接改域导致其内存缓存回写；移除对不存在的 `sessions.attachments` 的回退；增加目录删除的收敛重试，处理 detach 后 dispose 阶段重建目录的情况；删除 `__chameleon/session/list` 端点（客户端已不需要）。
- **v0.3.1（2026-08-14）**：修复删除后残留日志导致会话跑到「未分组」的问题；先删除磁盘日志并确认成功后再解除工作区记账。
- **v0.3.0（2026-08-14）**：新增英文适配（i18n）。

---

## License / 许可证

MIT — see [LICENSE](LICENSE)。/ MIT，见 [LICENSE](LICENSE)。
