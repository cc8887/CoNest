# 群聊如何识别 CoNest 注册成员

调研日期 2026-11-19。第一阶段已接入飞书群消息的账号绑定和主体匹配，使用模拟飞书事件验收。已验证成员可在显式启用的群中创建[私有定时任务](schedules.md)；下文的通用群聊工单和回传流程仍为设计建议。真实群和多个真实账号的链路待验收。[第一阶段配置与接口](architecture.md#飞书群聊主体识别)

## 结论

**群聊主体由 CoNest 宿主识别。** 宿主从已认证的渠道事件取得发送者 ID，用已验证的绑定查出一个启用的 `memberId`，然后按该成员的私有租户运行。AI 在授权之后理解“这条消息想做什么”和“提到了谁”。每条消息独立识别发送者，同一个群可以有很多注册成员，每位成员仍对应一个独立租户。[CoNest 术语](../../CONTEXT.md) · [CoNest 架构](architecture.md)

例如，甲在群里发「@CoNest 帮我整理这份清单，发给小林」。消息事件确定甲是发起人，清单工单属于甲。AI 可以从文本理解整理和转发的意图。平台结构化 `@小林` 可明确指向一个渠道账号，即使账号已绑定成员，首版也只处理甲自己的工单。发送给小林或访问小林的结果需要另行定义授权。

| 群聊中的问题 | 首版判断依据 |
| --- | --- |
| 谁发的、工单归谁？ | 平台事件的发送者 ID 加 CoNest 已验证的注册绑定 |
| 在哪个群、是否在叫机器人？ | 平台事件的群 ID 和结构化 `@机器人`，再检查群是否启用 |
| 这句话提到了谁、想做什么？ | 结构化 `@人` 和文本语义。昵称、引用、截图、声音和自称可以用于理解内容，权限始终以实际发送账号为准 |
| 谁可以看结果、回答追问、取消工单？ | 宿主检查操作人和工单归属。即使两人在同一群或同一话题里，也要逐次检查 |

## 渠道的实际能力

| 渠道 | 核实到的能力 | 对 CoNest 的影响 |
| --- | --- | --- |
| 飞书应用机器人 | `im.message.receive_v1` 提供发送者 `open_id`、发送者类型、`chat_id`、消息 ID 和提及列表。群内 @ 机器人可用 `im:message.group_at_msg:readonly` 权限。`open_id` 按应用识别，同一人在不同应用的值不同。飞书另有按开发商区分的 `union_id` 和按组织区分的 `user_id`。 | 建议先用一个自建应用和内部群验证。使用已认证连接上的飞书或 Lark 品牌、应用 ID 与发送者 `open_id` 查绑定。外部群和私聊有单独的配置与限制，目标群如果含外部用户，需另验双向相通和字段一致性。[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) · [权限说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/guide/faq) · [用户身份](https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/introduction) · [外部群与外部用户](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group?lang=zh-CN) |
| 普通微信 ClawBot / iLink | 腾讯官方插件声明 `chatTypes: ["direct"]`。协议文档明确，类型里的 `group_id` 仅表示有该字段，产品支持范围以实际能力为准。CoNest 现有 Source 还明确拒收任何带群 ID 的消息，只接收扫码 owner 的文本私聊。 | 微信继续提供私聊。普通微信群需要先取得能真实接收群事件和独立发送者 ID 的受支持入口。移除 CoNest 的过滤条件本身无法建立这条链路。[腾讯插件源码](https://github.com/Tencent/openclaw-weixin/blob/0ad1ae91347a938f52f1e4e2abd6dcda51e05f9e/src/channel.ts#L233-L241) · [腾讯协议说明](https://github.com/Tencent/openclaw-weixin/blob/0ad1ae91347a938f52f1e4e2abd6dcda51e05f9e/docs/protocol_zh_CN.md#L581-L602) · [CoNest 微信 Source](../../src/sources/weixin.ts#L26-L37) |
| 企业微信智能机器人 | 官方 SDK 的群消息回调分别提供 `chattype`、`chatid` 和发送者 `from.userid`。 | 可作为独立渠道评估。接入前用目标群实测可见范围、账号 ID 的作用域、绑定及私聊投递。其字段无法证明普通微信群可用，也无法直接关联现有 iLink ID。[企业微信智能机器人官方 SDK](https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/README.md#L457-L470) |

CoNest 用 `lark-cli event consume im.message.receive_v1 --as bot` 接收飞书事件。部署文档所用的 `lark-cli` v1.0.90 将事件的 `sender.sender_id.open_id` 转成 `sender_id`，另保留群 ID、消息 ID、发送者类型和结构化提及。该扁平结构未保留组织标识。若后续需要按飞书组织判断准入，应从可信连接或原始事件取得对应的组织标识，并区分接收应用所属组织与外部发送者所属组织。飞书组织标识与 CoNest 个人租户 ID 无直接对应关系。[CoNest 部署](../006-deployment.md#feishu-bot-optional) · [事件入口](../../src/sources/feishu-loops.ts#L64-L99) · [lark-cli v1.0.90 源码](https://github.com/larksuite/cli/blob/c8f06cd167fe352bf75a02f04a304875b9a68a2d/events/im/message_receive.go#L18-L103) · [飞书官方 SDK 的事件结构](https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/code-gen/events-template.ts#L4422-L4463)

## 建议的首版流程

1. **绑定已注册成员。** 成员登录现有个人空间，生成短期、一次性的配对码，并将其私聊发给接收群消息的同一个飞书应用机器人。宿主只接收来自该应用的可信用户私聊事件，将真实 `open_id` 和私聊投递地址暂存，再在发起绑定的已登录会话展示待绑账号供本人确认。配对码只保存摘要，在宿主内原子消费，从普通对话和模型上下文中剔除。绑定记录使用 `(平台及应用作用域, 发送者 ID) → memberId`。外部身份只能归属一位成员，冲突时拒绝。解绑后撤销渠道访问，保留历史工单归属和已占用身份的记录。飞书绑定和当前微信扫码绑定可指向同一个注册成员，跨平台关联来自用户分别完成的两次绑定。[现有注册与个人空间](architecture.md#注册与页面权限) · [飞书 ID 作用域](https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/introduction)
2. **在交给模型前解析身份。** 首版只处理明确允许的群里 @ 机器人且在绑定生效后发出的消息。检查发送者是人、身份字段完整、绑定唯一且成员启用，再按渠道和消息 ID 去重。实时、补收和话题等所有入口都要经过相同检查，首版可仅让实时消息驱动个人任务。失败时结束处理，群内需要反馈时使用统一的绑定提示。宿主把成员归属和消息接收一起写入原 Store，工单继承原始消息归属。模型只得到已授权的当前任务内容，首版省去模型侧群历史检索。[现有接收事务](../../src/app/runtime.ts#L183-L189) · [飞书历史及话题入口](../../src/sources/feishu-loops.ts) · [现有飞书上下文读取](../../src/sources/feishu-read.ts#L153-L166)
3. **把群来源和私有回传地址分开。** 话题 ID 和原消息 ID 用作来源记录。模型候选上下文和续接按成员分开，群话题中的消息在关联工单前比对双方归属。结果、追问、失败详情落到原成员的已验证私聊或个人空间，发送前复核绑定和成员状态。群内最多由宿主发固定回执，例如「请到私聊查看」，其中省去工单 ID、私有摘要和私有链接。绑定撤销或私聊不可达时，结果仍可在启用成员的个人空间查看。[现有工单归属](../../src/app/members.ts#L79-L115) · [当前飞书回复会回原消息所在话题](../../src/sources/feishu-channel.ts#L18-L29) · [现有私聊路由约束](../../src/ingress/messages.ts#L168-L203)

同一个飞书应用的用户授权也可取得该账号的 `open_id`，适合需要网页内授权的内部用户。官方说明，对外共享机器人无法获取外部用户的 `user_access_token`。目标是外部群时，应先验证外部用户能否主动私聊同一个机器人并完成配对。[飞书获取用户信息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get) · [官方 SDK 的用户信息字段](https://github.com/larksuite/oapi-sdk-go/blob/a3550335752a9af4662314e5838138562f04aa70/service/authen/v1/model.go#L1650-L1675) · [外部群与外部用户](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group?lang=zh-CN)

### CoNest 接入位置

- `src/ingress/messages.ts` 已区分发送者、渠道和会话，也有要求精确且唯一匹配的 `bindingFor`。可复用这个契约。现在通用群 Trigger 的线程由渠道和会话生成，两位成员在同一群时需要各自的私有任务会话，避免将群本身作为租户或共享记忆键。[入口契约](../../src/ingress/messages.ts#L150-L185)
- `Members.claim()` 目前只处理个人网页和已绑定微信私聊。未经认领的飞书 Trigger 和飞书线程仍走共享归属。新增的飞书个人租户入口需要在进入现有 Engine 前完成宿主授权和归属写入，避免未绑定或撤销的消息进入共享路由。旧飞书共享历史保留原归属。飞书来源的工单候选、读历史、回复及追问也要使用相同的成员检查。[归属实现](../../src/app/members.ts#L60-L115) · [飞书 Source 策略](../../src/sources/feishu.ts#L49-L85)
- 绑定和归属沿用原 Store，工单、Queue、Attention 和 outbox 继续复用。首版验证目标是**多人在同一群提供各自的私有任务入口**。群里共同读取某张工单、共享记忆或多人编辑属于后续产品需求，需要成员主动选择哪些内容共享以及给谁共享。[CoNest 架构](architecture.md)

## 验收建议

| 场景 | 应观察到的结果 |
| --- | --- |
| 同群两位已绑定成员使用同一昵称，在同一话题 @ 机器人 | 各自的工单、模型输入、追问和结果按 `memberId` 独立。改群昵称后原绑定仍有效 |
| 第三人未绑定，在正文自称甲、引用甲或转发甲的消息 | 使用当前消息发送账号处理。没有工单，也没有发往模型的正文 |
| 乙在同群回复甲的工单，或报出甲的工单编号要求查看、取消或续接 | 宿主拒绝访问，甲的工单状态保持，乙看不到甲的工单详情 |
| 换飞书应用、并发绑定同一外部账号、配对码过期或重复使用 | 换应用后需在新作用域验证，并发配对最多只有一个绑定成功。过期或重用的配对码被拒绝 |
| 收到重复推送、实时与补收重复、重启、投递前成员停用或解绑 | 同一原消息最多建单一次，保留原归属，撤销后的消息或投递被拒绝 |
| 机器人收到缺失发送者 ID 的消息、机器人回声或非允许群的 @ | 不建单，不调用模型。私聊发送不可用时群里也不出现私有结果 |

先用两位已注册成员和一位未绑定者，在同一个真实飞书群验证从绑定到私有回执。记录脱敏的发送者、群和消息标识对应关系，确认同一个飞书应用收到的该用户私聊与群聊 `open_id` 相符，并确认私聊实际收件。若业务要求普通微信群，先验证官方支持的群接入路径：至少两位真实账号各发消息，事件同时包含稳定、彼此不同且可验证绑定的发送者 ID 和同一个群 ID。
