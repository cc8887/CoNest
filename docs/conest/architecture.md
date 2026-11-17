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

平台管理员登录 DSH，通过 Superagent 的来源页进入成员注册界面。创建成员后异步生成微信二维码，并生成只交给对应成员的一次性个人链接。扫码确认后，宿主检查账号唯一归属、私有保存凭证，再将账号绑定、允许名单和绑定成功状态一并提交；无需手改 Source/Policy。失败时保留原绑定。PIN 只在内存和当前 provider 请求中使用，不写入数据库或日志。

个人链接一天内有效，兑换后失效；登录令牌只存摘要，浏览器使用 HttpOnly、SameSite=Strict Cookie。个人接口从 Cookie 解析成员，列表、报告、追问、停止和重试都检查所属工单。停用成员增加凭据版本，全部旧链接和登录立即失效，重新启用不会恢复旧凭据。平台界面可生成新链接，已有其他有效登录不因此失效。

个人服务默认监听 `127.0.0.1:3089`；DSH 管理端为 `127.0.0.1:3088`。平台注册接口要求 DSH Connection 的签名会话，租户凭据不能访问。独立 Origin 避免把 DSH Session、插件管理、文件等宿主能力暴露给个人页面。远程个人监听要求 TLS；HTTPS 代理只转发个人端口并保留 Host。决定见 [ADR 0001](../adr/0001-personal-portal-origin.md)。

## 私有路由与执行

每个成员有稳定私有 router，每个工单有独立 worker Session 与目录；全部共享 Engine 的执行槽位。每条成员请求独立建线程，由私有 router 决定建单或附加到本人的原工单。候选相关工单、分页列表、单资源读取、工具参数及异步返回均由宿主过滤。报告和 Attention 回到原成员 router，结果经原 outbox 返回对应渠道。

网页 `personal` Source 和微信绑定指向相同成员。网页可在未绑定微信时使用；停用微信 Source 不会隐藏本人已拥有的网页任务。来源策略仍是准入条件，可信成员身份不能由模型或浏览器任意指定。

成员模式只开放带宿主检查的工单工具，拒绝继承的 shell、文件、子 Agent、全局设置工具；所有受该 Runtime 管理的 Session 都遵循该限制。`prepare` 等配置由平台操作者负责。底层仍使用上游 `danger-full-access` 权限预设，目录命名和命令包装不是 OS 沙箱。任意代码执行须后续单独设计隔离。

## 微信与恢复

微信 Source 默认加载；空成员目录时暂停轮询，网页绑定后动态激活对应账号。每个账号仅接受其已确认 owner 的完整文本私聊，拒绝陌生人和群。bot/owner/member 归属不可换人复用，旧单 owner 共享历史需新状态和 DSH profile 才能切入成员模式。停用保留历史归属。

Trigger、回复上下文和游标在原 Store 同一事务提交。账号 id 进入幂等键、线程、游标、context 与回执；token/context 不进入模型提示词。发送分段有稳定客户端 id 与本地记录，不确定发送阻止盲目重发，需核实手机，不承诺服务端 exactly-once。本地凭证租约只覆盖同主机同路径，迁移前停止其他轮询进程。未完成扫码状态可重启恢复，二维码超时可重新生成。

明确禁用 GitHub 后不探测账号或仓库、不借用 ambient 凭证；普通文本任务沿现有 `ready → completed` 协议完成。保留原 GitHub/飞书使用方式和命令行初始化兼容。

## 验收与后续

真实开发机 DSH/hy4 单账号工单闭环和手机收件已由用户确认。当前本地 mock 验收通过网页创建 10 个租户、模拟扫码自动授权，再以真实 DSH 跑 100 张工单、单 worker 排队中途重启、定向追问、原账号结果回传；每次模型请求和个人页面结果均检查成员范围。浏览器还验证创建成员、绑定状态、网页提交与结果、手机布局。

新流程的 provider 和模型输入为 mock；多个真实微信账号、N100 性能、Windows/WSL 生命周期尚待现场验证。共享记忆、跨成员工单共享、群授权、OS 沙箱和完整资源预算均为后续能力；`src/family/authorize.ts` 的纯函数测试不能作为这些能力已实现的证据。目标仍为 N100 / WSL2、约 10 人、100 个未完成任务允许排队，先用 1 个 worker。部署步骤见 [微信主 Runtime](weixin-runtime.md)。
