# QQ 机器人接入

CoNest 可启动一个独立的 Python 进程，用腾讯云 [Octop Gateway v1.0.4](https://github.com/TencentCloud/octop-gateway/releases/tag/v1.0.4) 连接 QQ 开放平台的 WebSocket 和 HTTP API。CoNest 按应用、会话类型、会话与发送者绑定校验成员，并使用现有 SQLite、工单、私有 Session 和发件箱。一个 Runtime 可同时启用 QQ、飞书和微信。QQ 来源支持一个应用的文本消息。

| 已验证的输入 | CoNest 行为 |
| --- | --- |
| QQ `C2C_MESSAGE_CREATE` | 已绑定成员的私聊进入本人路由，可在原私聊收到回复 |
| QQ `GROUP_AT_MESSAGE_CREATE` | 允许群里的已绑定成员发给 Bot 的消息进入其私有路由，群内只有固定确认 |
| 回复 Bot 的群消息 | 根据 QQ 引用索引核对同群 Bot 消息。属于同一成员的原请求可作为其私有路由的引用上下文 |
| QQ `GROUP_MESSAGE_CREATE` | 智能群使用 CoNest 原有两阶段寻址。模型仅看到同一群、同一发送者的短期上下文，命中后才进入本人路由 |

群内只发送固定确认，工单标题、结果和追问在发起人的个人空间查看。已接收的原平台消息在本地去重，历史绑定不能换归属。QQ 被动回复使用原消息 ID 和持久化的回复序号，群确认有消息索引时发送为引用回复。Bot 回执的引用索引按应用及群匹配，一小时内有效，桥接重连后也可识别。明确限流可用相同序号重试，送达状态不明时保留待核对记录。QQ 全量消息与可用的发送规则由目标应用及群权限决定。[QQ 群消息接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)

## 复现本地验证

`pnpm test:offline` 通过同一 Runtime 的传输替身验证飞书、微信和 QQ 并行接收，以及 QQ 的 @、引用、无 @ 寻址和成员停用。协议测试另需 Python 3.12 或更高版本，启动真实 Octop，在本机回环地址模拟 QQ 的鉴权、WebSocket 事件和回复 HTTP API。它覆盖重连后去重和引用归属、群友闲聊及跨成员读取拒绝。寻址模型使用固定判断输出。

```sh
uv venv --python 3.12 /tmp/conest-octop-qq
uv pip install --python /tmp/conest-octop-qq/bin/python -r sidecars/octop-qq/requirements.txt
CONEST_QQ_TEST_PYTHON=/tmp/conest-octop-qq/bin/python pnpm exec vitest run tests/qq-ingress.spec.ts tests/octop-transport.spec.ts
```

## 使用真实 QQ 测试应用

1. 在已经启用成员及个人空间的 CoNest 源码实例上，使用独立测试应用和测试群。给 QQ 应用启用私聊及群 @ 事件。要验证未 @ 消息，目标群须开通「接收所有消息」。[QQ 全量群事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)
2. 将 `{"appId":"实际应用 ID","appSecret":"实际应用密钥"}` 保存到仓库外、由 Runtime 用户持有的 `0600` JSON 文件。在启动 CoNest 的环境设置三个绝对路径 `CONEST_QQ_BRIDGE_PYTHON`、`CONEST_QQ_BRIDGE_SCRIPT`、`CONEST_QQ_CREDENTIALS_FILE`。使用已安装 Octop 的 Python 虚拟环境和 `sidecars/octop-qq/bridge.py`。现有发布镜像未预装此 Python 运行环境。
3. 在高级控制台的来源设置启用「QQ」，填写与凭据相同的应用 ID。录入已核验的成员绑定。私聊的会话 OpenID 与发送者都填该私聊事件的 `user_openid`。群绑定填目标 `group_openid` 和该成员在该群事件的 `member_openid`。同一个人可以分别绑定两种入口。账号归属以核验后的 ID 为准。
4. 列出测试群并选择「仅 @」或「智能寻址」。智能寻址可以单独填写模型供应商和模型，留空时使用已配置的 Eval 模型。群里用续接消息验证无 @ 回复，再用明确面向其他群友的消息验证沉默。对同一成员再发私聊，确认私聊答案落到原会话。

本地已验证传输和隔离。真实 QQ 的平台授权、目标群里的本人识别、普通群消息推送及真机收件仍待现场验证。目前桥接使用固定 Octop 版本的 QQ 适配器内部接口，升级后应重跑协议测试。
