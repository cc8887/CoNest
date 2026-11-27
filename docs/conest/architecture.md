# CoNest 架构决定

当前源码提供网页成员注册、微信扫码自动绑定、独立个人界面、私有路由 Session、宿主工单权限和共享队列。每位成员就是一个独立租户，具体词义见根目录 [CONTEXT.md](../../CONTEXT.md)。平台管理员负责创建和停用成员，不在租户内再划分家庭管理员。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `src/core` / `src/app/store.ts` | 唯一的 Engine、Ticket、Assignment、Report、Attention、effects、outbox 和 SQLite Store |
| `src/app/members.ts` | 持久化成员与 bot/owner 归属、消息归属和私有 router id；在上下文读取、工具、执行和回传处检查范围 |
| `src/app/portal.ts` | 创建成员、一次性个人入口、网页登录、扫码生命周期、私有凭证保存与允许名单原子提交 |
| `src/app/portal-http.ts` / `src/portal` | 经 DSH 认证的平台注册界面，以及独立 Origin 的个人页面和受限接口 |
| `src/sources` | GitHub、飞书、微信与 personal 网页 Source，将外部请求转为原 Trigger，并复用 outbox |
| `src/family` | 尚未接入 Runtime 的共享领域设计：共享工单、记忆、参与者与群授权 |

不另建任务库、状态机或成员专属 worker 队列。成员和账号引用保存在 Source 设置；身份 pins、路由、扫码状态与网页凭据摘要保存在原 Store KV。工单归属从原始 Trigger 派生。内核仍不认识 Member，宿主在调用与投递边界执行授权。

新增源码和测试列在 [007 Architecture](../007-architecture.md)。单包保留 `dsh-superagent` 包名和插件 id，沿用 DSH 的插件、Source 和 Session 接口。`src/m0` 仍是独立探针，不创建工单。

## 注册与页面权限

平台管理员打开启动链接，沿用 DSH 的 launch token 兑换和签名 Cookie，随后默认进入 CoNest 后台。原 DSH 页面通过“高级控制台”（`/index.html`）显式打开，继续要求管理员认证。创建成员后异步生成微信二维码，并生成只交给对应成员的一次性个人链接。扫码确认后，宿主检查账号唯一归属、私有保存凭证，再将账号绑定、允许名单和绑定成功状态一并提交；无需手改 Source/Policy。失败时保留原绑定。PIN 只在内存和当前 provider 请求中使用，不写入数据库或日志。

个人链接一天内有效，兑换后失效；登录令牌只存摘要，浏览器使用 HttpOnly、SameSite=Strict Cookie。个人接口从 Cookie 解析成员，列表、报告、追问、停止和重试都检查所属工单。停用成员增加凭据版本，全部旧链接和登录立即失效，重新启用不会恢复旧凭据。平台界面可生成新链接，已有其他有效登录不因此失效。

个人服务默认监听 `127.0.0.1:3089`；DSH 管理端为 `127.0.0.1:3088`。平台注册接口要求 DSH Connection 的签名会话，租户凭据不能访问。独立 Origin 避免把 DSH Session、插件管理、文件等宿主能力暴露给个人页面。远程个人监听要求 TLS；HTTPS 代理只转发个人端口并保留 Host。决定见 [ADR 0001](../adr/0001-personal-portal-origin.md)。

## 私有路由与执行

每个成员有稳定私有 router，每个工单有独立 worker Session 与目录；全部共享 Engine 的执行槽位。每条成员请求独立建线程，由私有 router 决定建单或附加到本人的原工单。候选相关工单、分页列表、单资源读取、工具参数及异步返回均由宿主过滤。报告和 Attention 回到原成员 router，结果经原 outbox 返回对应渠道。

网页 `personal` Source 和微信绑定指向相同成员。网页可在未绑定微信时使用；停用微信 Source 不会隐藏本人已拥有的网页任务。来源策略仍是准入条件，可信成员身份不能由模型或浏览器任意指定。

成员模式只开放带宿主检查的工单工具，拒绝继承的 shell、文件、子 Agent、全局设置工具；所有受该 Runtime 管理的 Session 都遵循该限制。`prepare` 等配置由平台操作者负责。底层仍使用上游 `danger-full-access` 权限预设，目录命名和命令包装不是 OS 沙箱。任意代码执行须后续单独设计隔离。

成员模式中新建的受管理 Session 使用 `dsh-superagent-member` preset，包含时间上下文和压缩插件，角色工具由宿主注册到各自的 Agent。已经执行过的 Session 由 DSH 锁定原 preset，恢复时仍经过宿主工具限制和授权检查。个人空间的工单进度可显示当前 worker turn 的耗时，计时来自 DSH 会话事件，工单阶段来自 Store。

## 主动跟进授权接口

首版**默认不需要逐条审批**。只为「主动跟进一张现有私有工单」保留授权接口，不接入模型工具、自动监听、工单触发、消息推送或审批页面。普通问答、Attention 和已明确委托的定时计划不受影响。需要逐条审批时，在 DSH profile 的 `dsh-superagent` 插件配置中设置 `requireFollowUpApproval: true` 并重启；省略该键或设为 `false` 则不要求成员逐条批准。

- 可信宿主通过 `runtime.followUpAuthorization.request(memberId, ticketId)` 查询或登记。默认对有效成员自己的未结束工单返回 `not_required`，不写入审批记录。启用审批后，新请求返回 `pending`；同一工单在同一成员凭据版本下最多有一条记录，重试复用。待审批记录保存在现有 SQLite，重启可恢复，不占 worker，也不自动通知。
- 个人空间会话可 `GET /t/<memberId>/api/tasks/<ticketId>/follow-up-authorization` 查询。要求审批但尚未登记时返回 `not_requested`。同一路径 `POST` 提交 `{"requestId":"<查询返回的 ID>","decision":"grant"}`，也可用 `deny` 拒绝或用 `revoke` 撤销已批准的请求。沿用个人会话及 `x-conest-request: 1` 检查；跨租户工单不可见，无效或过期的状态变更返回 409。
- `pending` 和 `granted` 最多有效至登记后 24 小时，工单结束也会失效；停用成员使旧记录失效，重新启用不恢复旧授权。切回免审批模式不会覆盖有效成员凭据版本下的明确拒绝或撤销。将来接入监听时，宿主必须在执行前重新调用 `allows(memberId, ticketId)`，只有 `not_required` 或 `granted` 才能通过此审批检查；仍不得超出租户权限去读数据、推送或对外写入。

## 离线渠道测试

`pnpm test:offline` 包含飞书、微信和 QQ 的内存传输测试。飞书注入解码后的实时事件并捕获话题回复，微信注入账号收件批次并捕获发件参数，QQ 注入连接事件并捕获带原消息 ID 和序号的被动回复。三个替身都接到正式 Source，租户授权、Session 路由、定时任务、发件箱和 SQLite 沿用真实 Runtime。测试使用临时状态和合成账号，模型行为由测试预设。

生产传输沿用飞书 CLI、微信 iLink 和 QQ Octop。渠道协议检查使用各自的测试，业务离线回归可以直接替换收发接口。

## 飞书群聊主体识别

飞书 Source 支持 `identityOnly: true`，用于单独验收群聊中的注册成员识别。由平台管理员读取 `/orchestrator/api/settings` 的飞书 Source `value` 和 `revision`，保留现有配置，在 `value.config` 加入 `identityOnly: true`，通过 `PUT /orchestrator/api/settings/source:feishu` 保存 `{ value, revision }`。配置受部署账户设置权限保护，保存后重启 Runtime。使用飞书自建应用的消息事件订阅，在 `chats` 中列出验证群并启用 `directMessages`。未启用 `groupSchedules` 时，飞书 Source 只做身份匹配，工单入口和投递停用。

个人服务的以下接口沿用 `/t/<memberId>/api/` 的登录 Cookie 和 `X-Conest-Request: 1`。登录的成员需要在消息发送后回到发起配对的同一登录会话确认。

| 方法和路径后缀 | 用途 |
| --- | --- |
| `POST feishu-binding` | 生成一条五分钟内有效的 `conest-bind` 私聊指令。成员将整条指令发给接收群消息的同一个机器人 |
| `GET feishu-binding` | 查看配对进度、待确认的飞书发送者 ID 或绑定后的最近一次群聊匹配，分别以 `waiting`、`confirm` 和 `bound` 表示 |
| `POST feishu-binding/confirm` | 确认来自已认证机器人私聊的账号归属 |
| `DELETE feishu-binding` | 解绑并移除最近一次匹配记录。已确认过的账号归属仍保留 |

宿主用飞书品牌、应用 ID 和平台事件的发送者 `open_id` 查询唯一的有效成员绑定。仅接受指定群里绑定后发出的实时人类消息，默认要求结构化 @。停用期间不记录匹配。配对指令只保留摘要，群聊匹配每位成员最多保留一条群 ID、消息 ID 和时间。只识别时，消息正文不进工单库或模型。[群聊主体识别调研](group-identity-research.md)

在该模式上另开 `groupSchedules: true` 时，已验证且发给 Bot 的实时消息以独立私有候选进入发起成员的路由。群地址只用于保存后的固定确认，定时任务与到期工单保存在原 Store。时间推进和建工单在同一事务。用法见[成员定时任务](schedules.md)。

### 智能寻址

在高级控制台的飞书来源设置中，将指定群的「接收」设为「智能寻址」（`listen: smart`），并授予飞书应用读取群内全部消息的权限。经典飞书工单模式下，发起人须在飞书允许名单内。成员身份模式下须启用群定时任务并完成飞书绑定。

宿主先选择消息中的第一个已知 Bot @，再核对回复引用的发送者、当前人同一话题中已送达的待答追问，以及开头直接呼叫的名称或别名。明确回复另一位成员，或只有 @ 其他人的消息，保持沉默。补收历史只处理结构化 @。同一原消息用飞书消息 ID 去重，回答也沿用发件箱的稳定回执。

可在来源的高级设置填写 `groupModelProvider` 和 `groupModel`，留空时沿用已配置的评估模型。普通实时消息使用 DSH 的单次无工具模型调用，最多读取前面 8 条同群或同话题的消息。模型返回 `respond`、`confidence`、`reason` 和 `targetBotId`。最低置信度为 0.85，缺少模型、超时、输出无效或目标不符时保持沉默。路由完成后再次检查身份和配置。已有 Agent 决定直接回答还是受托执行，分类调用本身不启动 Agent 或创建工单。

每个 Runtime 对应一个飞书应用。多 Bot 部署时，给各实例设置一致的 `groupBots` 应用 ID、名称和职责，并按各应用所见的 `openId` 配置平台映射。为每个智能群指定相同的 `autonomousBotId`。有可验证话题根消息时，根消息的 Bot 作者或首个 Bot @ 优先拥有该话题的无引用追问和语义判断。其他群内普通消息只由该群的指定 Bot 判断。模型选中其他 Bot 时保持沉默，跨实例不会转交语义结果。优先按明确 @、回复或名称选择某个 Bot。单 Bot 使用当前应用和名称即可，配置名单可以留空。

规则优先级和按职责判断参考了 [Rakazo 的群聊路由说明](https://github.com/elie222/rakazo/blob/96b210e4a73047324603edbf6f59359f2a70e0bf/docs/groups.md) 和[群聊评估用例](https://github.com/elie222/rakazo/blob/96b210e4a73047324603edbf6f59359f2a70e0bf/packages/testkit/src/evals/group-routing.ts)。

## 微信与恢复

微信 Source 默认加载；空成员目录时暂停轮询，网页绑定后动态激活对应账号。每个账号仅接受其已确认 owner 的完整文本私聊，拒绝陌生人和群。bot/owner/member 归属不可换人复用，旧单 owner 共享历史需新状态和 DSH profile 才能切入成员模式。停用保留历史归属。

Trigger、回复上下文和游标在原 Store 同一事务提交。账号 id 进入幂等键、线程、游标、context 与回执；token/context 不进入模型提示词。发送分段有稳定客户端 id 与本地记录，不确定发送阻止盲目重发，需核实手机，不承诺服务端 exactly-once。本地凭证租约只覆盖同主机同路径，迁移前停止其他轮询进程。未完成扫码状态可重启恢复，二维码超时可重新生成。

明确禁用 GitHub 后不探测账号或仓库、不借用 ambient 凭证；普通文本任务沿现有 `ready → completed` 协议完成。保留原 GitHub/飞书使用方式和命令行初始化兼容。

## 验收与后续

真实开发机 DSH/hy4 单账号工单闭环和手机收件已由用户确认。当前本地 mock 验收通过网页创建 10 个租户、模拟扫码自动授权，再以真实 DSH 跑 100 张工单、单 worker 排队中途重启、定向追问、原账号结果回传；每次模型请求和个人页面结果均检查成员范围。浏览器还验证创建成员、绑定状态、网页提交与结果、手机布局。

新流程的 provider 和模型输入为 mock；多个真实微信账号、N100 性能、Windows/WSL 生命周期尚待现场验证。共享记忆、跨成员工单共享、群授权、OS 沙箱和完整资源预算均为后续能力；`src/family/authorize.ts` 的纯函数测试不能作为这些能力已实现的证据。目标仍为 N100 / WSL2、约 10 人、100 个未完成任务允许排队，先用 1 个 worker。部署步骤见 [微信主 Runtime](weixin-runtime.md)。
