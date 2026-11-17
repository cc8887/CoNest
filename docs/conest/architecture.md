# CoNest 架构决定

状态：已接入单 owner 微信 Source 和主 Runtime 的 GitHub 可选启动。`src/m0` 仍为独立连接探针；普通微信请求通过原有 Store、Engine、Ticket 和 outbox。家庭领域尚未接入运行时。部署和验证范围见[微信主 Runtime](weixin-runtime.md)与 [M0 文档](m0.md)。

## 仓库怎么切

一个 Git 仓库，三条边界：

| 模块 | 位置 | 职责 | 本次状态 |
| --- | --- | --- | --- |
| DSH 内核 | 上游的 `src/core`、`src/app`、`src/executor` 与插件入口 | 唯一的工单、Attention、Report 状态机。持久化仍是 `<stateDir>/orchestrator.sqlite`，只有 Store 打开它 | 沿用上游状态机，宿主支持禁用 GitHub |
| 家庭领域 | `src/family` | 成员、渠道身份绑定、会话范围、工单访问、记忆授权、Attention 投递目标，以及默认拒绝的纯函数 | 骨架。插件不导入它 |
| 渠道 Source | `src/sources` 的 `SourceKind` | 把外部事件译成 Trigger，并把回复写回渠道 | GitHub、飞书与新增的单 owner 微信 Source |

不另起一套工单库、调度器或记忆系统。以后如果要做独立网关，只能做传输，不能再写一份任务或记忆的事实来源。Octop 一类网关的想法留到那时再评估，本次不引入其代码。

家庭模块仍放在现有单包里。`pnpm-workspace.yaml` 仅为根包声明依赖构建策略，没有拆分子包。M0 新增 `src/m0/cli.ts` 构建入口，另外新增微信 Source 和一次性初始化入口，保留主插件、原 Source 与面板入口；M0 代码不会导入主插件。`src/family` 仍不在这些运行入口的导入图里。新增源码和测试已列入 `docs/007-architecture.md` 的清单。

上游领域模型明确拒绝把“人”或跨 Source 的身份映射做成内核实体：映射只作为提示词存在（`docs/001-domain.md` 的 Rejected concepts）。CoNest 的 `Member` 与 `IdentityBinding` 放在内核外面，就是为了不在本次初始化里改写这条规则，也不假装内核已经接受了它。

## 家庭对象

类型在 `src/family/domain.ts`。它们引用 DSH 的 Ticket id 或 Attention id，但不保存工单正文、报告或对话记录。

| 类型 | 含义 |
| --- | --- |
| `Member` | 稳定的家庭成员。`disabled` 不能通过授权 |
| `IdentityBinding` | 某个 Source 上的外部账号 id 属于哪个成员。`source` 使用 `SourceKind.kind` 的字符串，不另起一套渠道名 |
| `ConversationScope` | `dm` 只指向一个成员。`group` 只有房间 id，没有成员名单 |
| `TaskAccess` | 某个已存在工单的所有者、参与者和 `private` / `household` 可见性。不是第二个工单 |
| `MemoryGrant` | 记忆默认只有所有者可读。`member` 授权给一位成员，`household` 必须是一条显式记录，同住一个屋檐下不会自动获得 |
| `AttentionTarget` | 提议中的投递目标：哪个成员、哪一条工单、哪一个 Attention id、哪段会话 |

`authorize`（`src/family/authorize.ts`）对空目录和任何无法唯一解析的行动者一律拒绝。群会话在行动者解析成功后仍拒绝，原因是 `group_membership_unmodeled`。私聊只允许该成员；用渠道账号调用时，账号的 Source 还必须与会话的 Source 相同。

这组判断没有提示词参与。把它接进宿主之前，成员隔离并不存在。

## 内核扩展点

下面三项标明各自落地状态。代码阅读结论写在每一项里，避免把上游已有机制说成家庭功能，也避免把没有的机制说成已经有了。

### 1. 家庭授权执行 — 提议

已经存在的是按 Source 身份工作的策略门闩。`docs/002-authorization.md` 写明宿主执行允许名单、规则和 Mandate，消息和引用的文档不能改变这些权限。实现位于 `src/policy.ts` 的门闩与 Mandate 再验证，并由 Engine 在接受工作和恢复工单时使用。

没有存在的是成员级授权。内核没有 `Member`。跨 Source 的身份对应被 `docs/001-domain.md` 拒绝，并写成提示词。`src/index.ts` 与 `src/app/runtime.ts` 不导入 `src/family`。

提议的接法是在宿主里、在 Eval 接受、订阅扇出和将来的记忆读取之前调用默认拒绝的检查，并把拒绝做成宿主错误，而不是写进提示词。在那之前，`authorize` 的测试不能被引用为运行时安全。

### 2. 定向 Attention 路由 — 提议

已经存在的 Attention 是 `src/core/model.ts` 的 `{ id, question, triggerId? }`。`src/core/replies.ts` 把问题回复送到引发该问题的消息所在渠道；没有这条消息时，送到工单开始的渠道。`src/app/notices.ts` 的 `reportRelay` 把 `worker_attention` 交给主 Session。工单记录在 SQLite 里，重启后上游工单还在。

没有存在的是“发给指定成员”。Attention 上没有成员 id，回复也不查 `AttentionTarget`。家庭模块里的目标不会写入 `orchestrator.sqlite`。

提议的接法仍使用 Engine 里的那条 Attention：宿主在发送前读取目标成员的绑定，把问题送到该成员被授权的私聊，并把工单 id 与 Attention id 一起记下来，使重启后的发送仍指向同一次提问。不另建问题队列。

### 3. 非 GitHub 启动与非 PR 完成 — 部分落地

已经存在的 `prepare` 是一条 shell 命令。`src/policy.ts` 的 `executor.prepare` 由 `src/executor/dsh.ts` 的 `prepareDirectory` 在工单目录还不存在时执行一次。上游文档说典型命令是 `git worktree`。命令本身可以不是 git，失败会让工单失败。

结束条件仍然带着 pull request 的形状。`TicketOutcome` 含有 `merged` 与 `closed`，`Follow` 记录 `merged | closed`（`src/core/model.ts`）。GitHub 的跟随规则在 `src/sources/github-pull.ts`。执行器恢复文案要求查看 worktree、git 历史和 PR 状态（`src/executor/dsh.ts`）。没有 pull request 时，上游允许一条 `ready` 报告把工单结束为 `completed`；这不等于家庭任务已经有了独立的完成协议。

已落地：明确设置 `sources.github.enabled: false` 后不解析 GitHub 账号或仓库，不写 GitHub 凭证助手；GitHub CLI 调用会明确拒绝，主 Runtime 可以启动。非 PR 文本任务沿现有 `ready` → `completed` 路径完成，未改 Engine，也没有新增工单写入者。代码专用的恢复提示和通用工具隔离仍需后续改进。

## 私聊、群和提示词

私聊范围只命名一个成员。授权函数允许该成员在匹配的 Source 上发言，拒绝其他人。

群范围不包含名单。函数对群直接拒绝，避免出现一个总是成功的假适配器或假界面。上游飞书 Source 可以按配置接收群里的 @ 或全部消息，那是原型自己的准入表，不是 CoNest 的家庭群隔离，也不是微信群。

隔离必须由宿主执行。只在提示词里写“不要把甲的内容告诉乙”不算隔离。上游对策略门闩已经是这个态度；家庭数据还没有对应的宿主检查。

## 微信 Source

`src/sources/weixin.ts` 实现真实 `SourceKind`，通过 `./weixin-watch` 导出并在 bundle 中默认关闭。它与 M0 共用 `src/sources/weixin-api.ts` 的 iLink 传输。仅接受凭证文件中绑定 owner 的完整文本私聊；账号、owner 和私聊地址由宿主匹配，群与陌生人被拒绝。

`src/ingress/messages.ts` 已替换原抛错桩，完成消息到 Trigger、原私聊回复和网关契约映射。微信 Source 在原 Store 的同一事务内保存 Trigger、回复上下文和游标；重放不重复建单，也不会把旧 context 覆盖到新消息上。凭证和 `context_token` 不进入 Trigger 或提示词。

结果和追问使用现有 outbox，发送只能回到原绑定私聊。分段有稳定客户端 id 与本地发送记录；不确定发送会阻止自动重发，需操作者核实手机。该实现不承诺服务端去重或严格 exactly-once。同一凭证文件用本地租约防止重复轮询，其他主机仍必须由操作者停止。

设置中的凭证路径与绑定身份只能由管理面板修改。已绑定的账号或 owner 不能在原状态目录中换绑，因为主 Session 保存私聊历史；改绑必须使用新状态目录。当前每个 Runtime 只配置一个绑定身份，多成员共享主 Session 的隔离尚未实现。

协议参考锁定腾讯官方实现提交，版权声明见 `THIRD_PARTY_NOTICES.md`。真实双账号与 N100 现场验证仍待完成。家庭绑定与成员权限并未因 Source 接入而自动生效。

## 运行方向

目标机器是 Intel N100，已确认 Windows 11 专业版、15.8 GB 内存、WSL 2.7.14.0 和 Ubuntu WSL2/x86_64，开发方案以该发行版内运行 Linux 版本为目标。面向约 10 人的小家庭或小团队，最多约 100 个未完成任务，允许排队；单 owner 初始化配置为 1 个 worker。真机容量待测，当前 Node 18 / pnpm 10 先升级私有工具链。云端 hy4 配置见部署文档，版本号以 [provenance.md](provenance.md) 为准。

`SETUP.md` 是上游给操作者的安装对话。它会创建账号并要求在操作者自己的终端里登录。那一步不属于这次初始化。
