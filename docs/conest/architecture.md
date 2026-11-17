# CoNest 架构决定

状态：初始化。家庭领域没有接入 dsh-superagent 运行时。下文把已经在上游代码里核实过的行为和尚未实现的扩展分开写。扩展在落地并经过运行时测试之前保持“提议”。

## 仓库怎么切

一个 Git 仓库，三条边界：

| 模块 | 位置 | 职责 | 本次状态 |
| --- | --- | --- | --- |
| DSH 内核 | 上游的 `src/core`、`src/app`、`src/executor` 与插件入口 | 唯一的工单、Attention、Report 状态机。持久化仍是 `<stateDir>/orchestrator.sqlite`，只有 Store 打开它 | 原样导入，可按上游脚本构建和测试 |
| 家庭领域 | `src/family` | 成员、渠道身份绑定、会话范围、工单访问、记忆授权、Attention 投递目标，以及默认拒绝的纯函数 | 骨架。插件不导入它 |
| 渠道 Source | `src/sources` 的 `SourceKind` | 把外部事件译成 Trigger，并把回复写回渠道 | 仅上游的 GitHub 与飞书。没有新的适配器 |

不另起一套工单库、调度器或记忆系统。以后如果要做独立网关，只能做传输，不能再写一份任务或记忆的事实来源。Octop 一类网关的想法留到那时再评估，本次不引入其代码。

家庭模块放在现有单包里，而不是新建 pnpm workspace。`package.json` 仍是一个包，`tsdown` 的入口仍是 `src/index.ts`、`src/sources/github.ts`、`src/sources/feishu.ts` 和 `src/client/index.tsx`。`src/family` 不在这些入口的导入图里，因此不会打进插件。`tests/docs.spec.ts` 要求 `docs/007-architecture.md` 列出每一个 `src` 文件和每一个 `tests/*.spec`，所以该表增加了三行说明，声明这些文件未接入。

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

下面三项都是提议。代码阅读结论写在每一项里，避免把上游已有机制说成家庭功能，也避免把没有的机制说成已经有了。

### 1. 家庭授权执行 — 提议

已经存在的是按 Source 身份工作的策略门闩。`docs/002-authorization.md` 写明宿主执行允许名单、规则和 Mandate，消息和引用的文档不能改变这些权限。实现位于 `src/policy.ts` 的门闩与 Mandate 再验证，并由 Engine 在接受工作和恢复工单时使用。

没有存在的是成员级授权。内核没有 `Member`。跨 Source 的身份对应被 `docs/001-domain.md` 拒绝，并写成提示词。`src/index.ts` 与 `src/app/runtime.ts` 不导入 `src/family`。

提议的接法是在宿主里、在 Eval 接受、订阅扇出和将来的记忆读取之前调用默认拒绝的检查，并把拒绝做成宿主错误，而不是写进提示词。在那之前，`authorize` 的测试不能被引用为运行时安全。

### 2. 定向 Attention 路由 — 提议

已经存在的 Attention 是 `src/core/model.ts` 的 `{ id, question, triggerId? }`。`src/core/replies.ts` 把问题回复送到引发该问题的消息所在渠道；没有这条消息时，送到工单开始的渠道。`src/app/notices.ts` 的 `reportRelay` 把 `worker_attention` 交给主 Session。工单记录在 SQLite 里，重启后上游工单还在。

没有存在的是“发给指定成员”。Attention 上没有成员 id，回复也不查 `AttentionTarget`。家庭模块里的目标不会写入 `orchestrator.sqlite`。

提议的接法仍使用 Engine 里的那条 Attention：宿主在发送前读取目标成员的绑定，把问题送到该成员被授权的私聊，并把工单 id 与 Attention id 一起记下来，使重启后的发送仍指向同一次提问。不另建问题队列。

### 3. 把 prepare / 结束与 PR、git 脱钩 — 提议

已经存在的 `prepare` 是一条 shell 命令。`src/policy.ts` 的 `executor.prepare` 由 `src/executor/dsh.ts` 的 `prepareDirectory` 在工单目录还不存在时执行一次。上游文档说典型命令是 `git worktree`。命令本身可以不是 git，失败会让工单失败。

结束条件仍然带着 pull request 的形状。`TicketOutcome` 含有 `merged` 与 `closed`，`Follow` 记录 `merged | closed`（`src/core/model.ts`）。GitHub 的跟随规则在 `src/sources/github-pull.ts`。执行器恢复文案要求查看 worktree、git 历史和 PR 状态（`src/executor/dsh.ts`）。没有 pull request 时，上游允许一条 `ready` 报告把工单结束为 `completed`；这不等于家庭任务已经有了独立的完成协议。

提议的接法是扩展现有工单、Report 和 Follow 路径，让非代码任务不必打开 pull request 也能完成，并且不新增第二个工单写入者。本次不改 Engine。

## 私聊、群和提示词

私聊范围只命名一个成员。授权函数允许该成员在匹配的 Source 上发言，拒绝其他人。

群范围不包含名单。函数对群直接拒绝，避免出现一个总是成功的假适配器或假界面。上游飞书 Source 可以按配置接收群里的 @ 或全部消息，那是原型自己的准入表，不是 CoNest 的家庭群隔离，也不是微信群。

隔离必须由宿主执行。只在提示词里写“不要把甲的内容告诉乙”不算隔离。上游对策略门闩已经是这个态度；家庭数据还没有对应的宿主检查。

## Source 下一步

新增渠道要按 `docs/008-cookbook.md` 实现真实的 `SourceKind`（`src/sources/kind.ts`）：schema、字段、健康项、把事件译成 Trigger 的规则、回复渠道，以及在 `tsdown.config.ts`、`package.json` 导出和 `cordis.patch.yml` 里注册插件。GitHub 与飞书是现成的两个插件入口。

本次没有添加 Source 骨架。`SourceKind` 的最小对象虽然能写出来，但没有真实传输时，注册进去只会变成一个不会失败的空壳。下一个接缝就是上面这一条注册路径。

信息流接入还没有接到运行时。`src/ingress/not-connected.ts` 只放契约类型，每次调用都抛出 `IngressNotConnected`。`tests/message-ingress.spec.ts` 写这些契约：标明 `contract:` 的用例在桩被替换之前会失败；标明 `current:` 或 `unimplemented:` 的用例核对已经成立的拒绝，以及桩没有接入插件入口、`cordis.patch.yml`、`package.json` 导出和 `tsdown.config.ts`。这里不引入 Octop 的代码，也不把它做成运行时依赖。

微信、WeChat Claw、iLink 的群支持没有对照官方能力核实。不要把飞书适配器改名成微信，也不要在未核实的接口上做群收发。测试只断言这些名字没有注册成 Source。

接入新 Source 时，家庭绑定使用该 Source 自己的发送者 id。在绑定被宿主执行之前，新 Source 只具有上游原型那种按渠道账号允许的能力。

## 运行方向

目标机器是 Intel N100，内存和操作系统未知，所以不设置内存上限、不改 `maxWorkers`、不对延迟或吞吐做任何声明。模型调用使用 DeepSeek Harness 配置文件中的云端供应商，不在本仓库内置本地模型。版本号以 [provenance.md](provenance.md) 为准。

`SETUP.md` 是上游给操作者的安装对话。它会创建账号并要求在操作者自己的终端里登录。那一步不属于这次初始化。
