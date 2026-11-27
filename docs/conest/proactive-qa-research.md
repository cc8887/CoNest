# CoNest 主动问答：让 AI 自己决定跟进什么

2026-11-27 · 源码与产品机制调研 · 设计提案，非现有能力

实施决定：首版只提供[默认无需逐条审批的接口和可配置的持久化等待](architecture.md#主动跟进授权接口)，不开启下面讨论的自动监听、触发和投递。

## 建议：一次授权，AI 自主跟进

每位成员可在个人空间开启一次「主动跟进我的任务」。此后 **AI 自己决定监听什么、何时检查、何时停止，以及是先把答案准备好，还是现在问成员**，不用为每条监听弹审批。CoNest 只让它在该成员已经授权的事件与私有投递范围内行动。首版从 CoNest 自己的工单状态和这位成员的私聊开始，不接全量群消息、不追加连接器读取权限，也不赋予对外发送或改数据的权力。

这里的「监听」是一条有条件、有期限的订阅，不是一直打开模型，也不是让 Agent 写任意轮询脚本。三种动作独立计量和限制：**跟进**（保存订阅）；**处理**（命中后查一下、整理答案或在授权下执行）；**打扰**（主动给成员发消息）。跟进可以自动开启，不等于必须花模型额度，更不等于必须推送。

| 成员说了什么 | CoNest 可以自主做什么 |
| --- | --- |
| 「这类部署任务卡住的话，你看着办，真需要我决定再找我。」 | 用宿主可验证的任务标签或模板匹配；监听以后同类工单进入等待状态。如果已能从本人授权上下文继续，先准备答案；仍缺关键信息时才问一个具体问题。首版只支持可绑定到具体工单或有结构化分类的类别，不用一句模糊描述扫描全部历史。 |
| 「等这个排查有结论，先帮我整理一下。」 | 建一个绑定本人这张工单的一次性跟进；结论出来后补一段可用的摘要，默认先进个人待阅；常规工单结果仍沿用现有回传，不发第二份。停单或结论被后续更新取代时，撤掉没发的旧内容。 |
| 「大概下周要交材料。」 | 当成可能有用的线索，不把随口提及当成承诺，不建长期 watch，不主动追人；若和本次任务直接有关，可以当回合问清一个关键点。 |

不要求成员逐条确认；成员始终能看见「正在跟进什么、为什么、什么时候结束」，能停一条、静音一类或暂停全部。显式「不要再提醒」立即生效；未回复不等于拒绝也不等于同意，只结束或暂缓本次打扰，不据此扩大权限。已有明确时间的定时任务不受新功能的推断规则影响。

## 为什么不是照搬一个项目

| 对照机制 | CoNest 的选择 |
| --- | --- |
| [OpenClaw Standing intents](https://docs.openclaw.ai/concepts/standing-intents) 用关键词做零模型预筛，限制作用域、冷却、次数与期限。[问题与关闭记录](https://github.com/openclaw/openclaw/issues/86356) 记录过期跟进的案例，并说明主分支已退役推断承诺；显式 intent 是另一套机制。[私聊跨会话回忆](https://docs.openclaw.ai/reference/memory-config) 不把群作为来源或目的地。 | 保留硬过滤和期限，但允许 AI 依据可信任务以及成员一次授予的自治范围**自动建短期订阅**；不把任意闲聊、AI 自己的承诺或收到的事件当授权。 |
| [Hermes Agent Telegram 网关](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md#observe-group-chatter-without-auto-replying) 的 `observe_unmentioned_group_messages` 让允许范围内的未寻址群消息成为话题上下文，不启动 Agent；[委派文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation) 区分后台委派与完成通知。 | 借「看到和唤醒分开」，不复制群上下文到租户私有路由，不在每条消息上调用模型，也不另开 worker。 |
| [projection-memory-benchmark](https://github.com/larsderidder/projection-memory-benchmark) 评测变更后的未来意图、待办及何时保持沉默。它是离线评测，不是生产订阅引擎。 | 命中只是候选，发送前再读取最新状态。取消、解决、被取代、已通知四类用例要有负例回归。 |
| Radar 的 shadow、moqi 的 Feed、Butler 的等待状态，另见源码附录。 | 借「先本地可见、后私聊」和有结局的跟进。试点用无外发模式校验误报和成本；不是要求每个成员逐条审批。 |
| 非开源机制：[Claude Duet](https://claude.com/resources/articles/claude-duet) 描述后台推进、需要判断或决定时再介入；[Grok Bot Routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) 区分定时与事件触发，说明长时间离开时可能询问是否继续，无回应则暂停；[OpenAI Dots](https://learn.chatgpt.com/docs/dots/tasks-and-memory) 区分在已授权数据上研究、已委托工作及受支持的事件监听，连接来源本身不创建监听；[Meta Muse 给定帮助页](https://www.meta.com/help/superintelligence/1484325780075655/) 证实定时、地理围栏、可见与可撤销，不证实自主推断订阅。 | 借分层和可见可停，不复制逐条审批界面；将无回应降噪花在真正反复打扰的事项上。自动暂停是 Grok 公开描述的机制，不归到引用的 Dots 页面。 |

MaiBot、AstrBot 属于另一条路线：**这条群消息是否值得我现在插话**。CoNest 已有[飞书智能寻址](architecture.md#智能寻址)；续建它不应成为主动跟进首版的前置条件，也不能把「未发给我」直接翻转为「能监听」。

## 如何落在现有 Runtime

现有 [Schedules](../../src/app/schedules.ts#L98) 已展示同一 SQLite 持久化、到期前重验、稳定触发键和队列复用；它依赖成员的明确时间请求，不改成 AI 猜日期的入口。[Runtime](../../src/app/runtime.ts#L197) 已能观察 `ticket.ended` 等领域事件；现有 [DomainEvents](../../src/core/ports.ts#L89) 未列出 `attention.changed`，真正做「阻塞」订阅时，应从已有工单/Attention 状态派生变更或在统一状态写入处发明确事件，不能假设现在已经有这个事件。[Members](../../src/app/members.ts#L64) 负责绑定归属与读取范围；[Outbox](../../src/app/outbox.ts#L28) 已有稳定回执和发送前授权钩子，但新跟进仍需增加本用途的状态复核。

1. **登记。** 在 `src/app` 增加宿主编排服务，用现有 Store 保存 `FollowUp`，不是第二套工单库。首批只让成员私有 router 的一个受限工具创建或更新：提交触发条件、已有工单或策略范围、结束条件、为何值得跟和期望动作。成员 ID、来源、路由地址与授权版本由宿主推导，模型不能填写；校验事件类型、资源归属、期限、配额以及取消记录。相同跟进合并；同一工单和授权版本被手动停用后，不允许模型自行重建。启动后续跟进不能成为自动任务再派生订阅的途径。
2. **匹配。** 从现有领域事件及到期检查取信号；按成员、事件类型、工单 ID 或受控分类做索引匹配。只在事件符合条件后，才允许为难以确定的候选做一次短判断。事件正文是证据，不是指令；模型看不到其他租户、无关历史、凭证，也不能自定目标地址。能用宿主状态判断的「已取消」「已完成」「已经问过」不调模型。
3. **决定。** 模型只选 `silent`、`feed` 或 `ask`，并说明发生了什么、为什么值得现在问。默认 `feed`；只有不问就不能推进或需要成员明确决定时才用 `ask`。若当前已有尚未回答的 Attention，复用原问题，不创建第二条；回答回原工单的现有续接路径。普通提示可先入待阅，不占用 worker；真正需要后台工作的事件才由宿主生成带稳定 ID 的 Trigger，用原 Engine 的授权、队列和报告，不能冒充新的人类请求。让自主工作在前台空闲时入队，不改变首发单 worker 或抢占活跃工单。
4. **提交与投递。** 模型返回后、写待阅或建单前、对外发送前都按当前版本复核成员、绑定、跟进、工单状态及通知预算。匹配与待处理记录原子写入；事务外异步推断，提交时拒绝已过期的判断结果。使用稳定事件键和投递键，重启恢复未完成决策并重新核验，不批量重播历史。待阅写入、排队、已送达和状态不明分开记；私聊不可达则结果留在个人空间，不改投其他账号或群。底层无法确认的外部发送沿用现有不盲目重发规则，不承诺外部 exactly-once。

### 上线顺序与验收

- **第一步：私有工单的短期跟进。** 支持监听具体工单的「有结果」，以及一个类别条件「本人的工单等待本人超过 N 小时」，由 AI 决定哪些已授权事项适合启用、等多久，不从所有聊天挖承诺。个人空间先做一个最小「待阅 / 正在跟进」视图和停止入口；成员开启后允许 AI 静默创建。可用建议值：每人同时最多 5 条，默认 7 天自动到期，同一事项只主动问一次。先用无外发试点记录本来会不会问，再开经过核验的私聊外发；每人每日最多 1 条新增主动推送，静音期间延后，到发送时再次核验。上述数字是初始试点参数，不是性能测量值，也不计入主动跟进以外的正常结果和显式提醒。
- **第二步：扩展可监听的工单类别。** 允许 AI 组合受控标签、事件类型和等待时长建短期订阅；不用每天扫全库或逐条 LLM 分类。重复有用的结果才考虑续期；同一订阅不会因自己产生的新工单再次触发。只有已接入且能证明使用主体与授权范围的外部来源，才考虑扩展到外部事件；群读权限、私聊投递能力和外部写权限分别验证。
- **离线门槛。** 复用 `pnpm test:offline` 的真实 Runtime、SQLite 和模拟模型：10 租户同名工单，检查输入、订阅、待阅、Attention 和 outbox 均不串；测同一事件重复和重启、AI 判断中撤权、私聊待发时取消或已解决、正常回执不重发、前台单 worker 饱和和无关事件零模型调用。再观察每位成员主动打扰次数、主动问题的有效答复率、重复/过期消息、前台排队时间，以及候选命中前后的模型调用量。真实微信无人刚发消息时能否送达、N100 会否拖慢前台，都留给现场验证。

本次只做调研；现有 `pnpm test:offline` 基线为 3 个文件、14 项通过（6.10 秒），不代表已实现或验证上述机制。

## 源码附录：主动性与打扰控制

Linger 为源码可见的非 OSI 开源许可单独列项，其余项目的复用依各自许可。以下为参考实现，不是 CoNest 已具备的能力。

**证据口径。**「源码」指固定提交中可追溯的分支、持久化或运行入口。「提示词」指交给模型遵循的行为。「文档」指作者陈述。Radar 和 Butler 取 Hermes Marketplace 标注的审核提交，市场上架和审核记录仅作为版本出处。本文为静态查阅，实际送达、模型判断质量和隔离效果仍待运行验证。[Radar 市场条目](https://hermes-agent.nousresearch.com/marketplace/hermes-proactive-radar) · [Butler 市场条目](https://hermes-agent.nousresearch.com/marketplace/butler-assistant)

### Linger / Another Me

- **源码 · 触发与跟进。** 本人消息进入专属直聊后，每累计 20 条普通消息触发一次审阅。启用自动提醒且获授权的应用连接可各自轮询，配置间隔 600 秒。事件按租户、人员、来源、外部 ID、状态和日期去重，入队及投递时复核连接授权。隐藏唤醒等待会话安静 3 分钟，外部事件另有 1 分钟聚合等待。Tracking Item 可关联后续 Routine，关闭时以租户、人员及版本更新。[直聊入口](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/node-services/src/agent/agent-features/proactive/feature.ts#L16-L63) · [监听器](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/teamhub/internal/proactive/listener.go#L23-L55) · [事件处理](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/teamhub/internal/proactive/event.go#L123-L259) · [唤醒投递](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/teamhub/internal/reminder/quiet_wake.go#L157-L209) · [跟进关闭](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/teamhub/internal/reminder/tracking_items.go#L302-L311)
- **源码与提示词 · 降噪和学习。** 普通事件在宿主本地时间 22:00–08:00 或达到 5 个提醒型事件唤醒后，仍入队，但附加「只跟踪、保持沉默」提示词。标成 urgent 的事件跳过此门槛。计数对象是事件唤醒，静默依赖模型遵从该指令。Dreaming 实现读取人员范围内的主动消息及后续回复，生成带版本的规则与线索。两次同类隐式反馈或一次明确偏好可成规则是提示词规则，文档用夜间运行及示例展示，实际归类质量未验证。[事件门槛与计数](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/teamhub/internal/proactive/event.go#L183-L215) · [计数查询](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/teamhub/internal/store/queries/proactive.sql#L72-L76) · [静默提示词](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/teamhub/internal/reminder/wake_prompts.md#L7-L21) · [Dreaming 实现](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/node-services/src/memory/proactive-dreaming.ts#L263-L307) · [学习提示词](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/apps/node-services/prompts/memory/proactive/dreaming.md#L31-L51) · [作者文档](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/docs/proactive.md)
- **借鉴边界。** 可参考事件身份、授权撤销复核、会话安静窗口，以及先记录线索再形成偏好。TeamHub 的 Room、River 和 Tracking Item/Routine 互相依赖，机制适合独立实现。源码许可为修改版 Apache 2.0，面向组织外第三方托管 Linger 受书面授权条款约束，使用其前端还有标识限制。[许可证原文](https://github.com/simplexai-labs/linger/blob/43c02e4bf47ab271a4881a00906e4fabc49fc6ec/LICENSE#L3-L25)

### Hermes Proactive Radar

- **源码 · 持久化生命周期。** 多源信号先经规则筛查，再由模型提取，按线程、实体或日期重叠找候选任务并重新规划。Task、Proposal、Job、Outbox 各有自己的状态，提议可暂缓、拒绝或接受，任务终态会拦住自动作业，已有副作用可能性的失联作业按 unknown 收尾。默认禁用且为 shadow，后者阻止主动通知投递。启用 active 后，投递前还检查安静时段、邮件线程是否已推进及提议是否仍有效。[处理入口](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/pipeline/process.py#L258-L365) · [候选任务](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/pipeline/correlate.py#L141-L182) · [状态模型](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/models.py#L13-L94) · [作业恢复](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/jobs/service.py#L358-L402) · [默认配置](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/plugin.yaml#L32-L36) · [投递处理](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/scheduler.py#L634-L679)
- **源码 · 注意力与授权。** 按任务冷却，问题未答时抑制重复提醒。注意力规则可将安全、服务中断、到期或财务损失提到立即通知候选，任务静音优先，实际发送还走投递门槛。动作按 read/local/external 分级，autonomous 仅放行明确列出的外部动作。邮件发送和邮箱草稿须经本人授权并走确定性执行器，支付、预订、部署、合并禁止自动执行。聊天模型代点接受 owner-only 提议会被拒绝，执行入口再检查。[提醒节奏](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/delivery/dispatch.py#L130-L190) · [注意力策略](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/pipeline/attention.py#L29-L63) · [信任策略](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/trust.py#L13-L96) · [接受入口](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/delivery/responses.py#L169-L181) · [执行门槛](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/jobs/service.py#L59-L113)
- **借鉴边界。** 可参考分离提议与执行状态、投递前重验和未知结果的恢复策略。MIT 代码可按许可证条件择取。Hermes gateway、profile、工具权限及 oneshot 子进程是宿主集成边界。shadow 可用于评估「会发什么」，其投递开关本身无法证明零模型消耗、零连接器访问或零副作用。跨租户身份绑定与真实渠道收件效果未核实。[MIT 许可](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/LICENSE) · [作者的宿主依赖说明](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/README.md) · [调度循环](https://github.com/Naroh091/hermes-proactive-radar/blob/5dd9fbe198117735c01cc6a19131ad83e34df36d/radar/scheduler.py#L144-L226)

### moqi（wangcao-hub/moqi）

- **源码 · 提议与反馈。** Heartbeat 推进到期 watch、待办和提议过期。反思可由约 2 小时周期或对话安静 10 分钟触发，每轮最多 3 个想法，每日最多 2 个认识用户的问题，并防止近期重复。宿主按类型阈值、静音、安静时段和每日通知额度决定 notify/feed/drop。默认 22:30–08:00 静默，主动通知每日 3 条。静默期例外要求 urgency 为 now 且价值至少 0.9。用户亲设时间的提醒直接走 notify，且不占主动预算。接受、忽略、拒绝或静音成为事件并按类别调整阈值或静音状态。[Heartbeat](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/moqi.ts#L615-L641) · [反思触发](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/moqi.ts#L705-L714) · [反思限制](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/reflect.ts#L16-L30) · [通知策略](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/proactive.ts#L16-L54) · [反馈归约](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/state.ts#L210-L258)
- **源码 · 动作边界。** Watch 只调用声明为 read 的工具，对比本次与上次结果后可提出通知。普通写操作默认先询问，并有工具级信任上限。连续 3 次批准后可以提出升档，用户接受才升档，拒绝会重置信任。受保护的危险工具走单独确认分支，接受模型拟写的提议仍可能要求确认精确动作。[Watch 运行](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/moqi.ts#L644-L691) · [默认动作策略](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/plugin.ts#L76-L79) · [信任阶梯](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/autonomy.ts#L16-L40) · [确认与升档](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/moqi.ts#L450-L476) · [升档提议](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/moqi.ts#L512-L526) · [批准计数](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/state.ts#L19-L30)
- **借鉴边界。** Apache 2.0。纯函数通知策略、按类反馈和 JSONL 事件归约适合参考。当前 Offer 在回调前记录 delivered，接受也先记录 verdict 再执行动作。这些状态适合表达本地决策，无法单独证明消息送达、动作成功或崩溃后可靠续作。工具的 read 标签依赖插件声明。README 明示 auto-undo 目前需要对应取消操作，通用自动回滚未实现。[许可证](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/LICENSE) · [JSONL](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/node/file-store.ts#L14-L41) · [投递与动作顺序](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/src/core/moqi.ts#L529-L567) · [README 的撤销限制](https://github.com/wangcao-hub/moqi/blob/a62e5aa99b3b2f2cf90caa2bbbe3704761cf8e78/README.zh-CN.md#L290-L299)

### Butler（haykguy/butler）

- **源码 · 承诺与唤醒。** Hermes 插件在已准入的网关消息或绑定会话回合上延迟启动 runner。承诺、每日必做事项、check-in、文件 watch 和 open loop 可由工具登记，按 profile 存 SQLite。到期项用租约认领并按路由合批，经策略后向已绑定会话注入普通 Agent 回合。无周期项进入 submitted，模型需显式延期、完成、停止或暂停才会改变其状态。周期项按已设间隔推进，已完成的每日事项支持按本地日期复位。[插件入口](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/__init__.py#L16-L62) · [登记工具](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/tools.py#L213-L324) · [租约与每日复位](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/store.py#L331-L402) · [注入入口](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/runner.py#L407-L486) · [跟进状态](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/followup.py#L250-L290)
- **源码与提示词 · 打扰限制。** 默认关闭通知。可设暂停、安静时段及日额度，未答上限默认 5，最短间隔默认 1 分钟。未答超限时停放这些到期项，间隔不足时延期。「先准备再开口」、是否发言及下次时间交给模型。注入被接受会推进事项，后续钩子按模型是否产生可见正文计数，两个信号均无法证明渠道已送达。[默认值](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/settings.py#L32-L63) · [唤醒策略](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/policy.py#L94-L172) · [未答与间隔](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/runner.py#L304-L315) · [停放与延期](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/runner.py#L590-L627) · [模型指令](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/followup.py#L418-L447) · [回合计数](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/awareness.py#L278-L299)
- **借鉴边界。** MIT。可借鉴「提交唤醒后等待处理」、未回复刹车和路由验证。DM 正文采集需要插件及 profile 双重启用，默认私聊历史回灌因缺少可信会话身份禁用。电话和平台送达依赖宿主及外部服务，实际运行未核实。[MIT 许可](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/LICENSE) · [采集与回灌](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/event_hooks.py#L133-L219) · [profile 开关](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/butler/policy.py#L54-L63) · [平台依赖](https://github.com/haykguy/butler/blob/018a484d7d7e71489c1c5daf98948930a9a49722/plugin.yaml#L19-L41)

### MaiBot / AstrBot 的最小相关机制

- **MaiBot。** Planner 有正文却漏掉工具调用时，才用最近 5 条真实消息做一次补判，限制为 reply 或 wait，按声明校验参数，Focus 还取两种工具共同允许的会话。可参考回合内「说或等」与会话范围约束，对长期跟踪和主动投递无相应证据。[动作补判源码](https://github.com/Mai-with-u/MaiBot/blob/edf42446f123149c57fc79765dd5a8b004b8524c/src/maisaka/planner_action_judge.py#L39-L120)
- **AstrBot。** 内置 future_task 按会话 UMO 建任务，启动从数据库恢复已启用的持久日程。到期唤醒目标会话的主 Agent，结果投递由 Agent 调用专用工具。一次性任务由定时入口执行后清理，手动执行保留日程。可参考定时触发和显式投递目标，官方文档将其定位为已建任务的定时执行。[创建工具](https://github.com/AstrBotDevs/AstrBot/blob/7c8a8d7f617db264a5775fd46b375c067634464b/astrbot/core/astr_agent_runtime/tools/cron_tools.py#L110-L148) · [启动恢复](https://github.com/AstrBotDevs/AstrBot/blob/7c8a8d7f617db264a5775fd46b375c067634464b/astrbot/core/cron/manager.py#L127-L161) · [运行与清理](https://github.com/AstrBotDevs/AstrBot/blob/7c8a8d7f617db264a5775fd46b375c067634464b/astrbot/core/cron/manager.py#L376-L492) · [作者文档](https://github.com/AstrBotDevs/AstrBot/blob/7c8a8d7f617db264a5775fd46b375c067634464b/docs/zh/use/proactive-agent.md)

**方向 1 的设计取舍。** 以上是对可借鉴机制的判断。Linger 提供事件转跟踪与偏好学习的参考，Radar 提供持久提议、授权和投递重验，moqi 提供可解释的打扰策略，Butler 提供承诺到期后的持续追问及停放。采用时需由接收系统分别定义记录、发言、执行的授权点及其成功证据。
