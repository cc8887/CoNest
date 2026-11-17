# CoNest 项目记忆

以下信息由用户在 2026-11-17 指定，后续开发与测试沿用。

- 项目基于 DeepSeek Harness 的 dsh-superagent，目标是部署在 Intel N100 上、支持多用户的 Agent。
- 目标机为 Windows 11 专业版，物理内存报告 15.8 GB，系统版本 `10.0.26200.9974`；WSL `2.7.14.0`、内核 `6.18.33.2-2`、Ubuntu WSL2 / `x86_64`。同机另有 Podman 与 Docker 发行版，先前 Podman 机器正在运行。信息由用户于 2026-11-17 提供。
- 面向小家庭或小团队，约 10 位用户；云端推理；入口优先微信机器人；网页注册与个人任务空间已在后续迭代接入，飞书成员入口待扩展。
- 用户已澄清容量口径：最多约 100 个未完成任务，允许排队；不是 100 个任务同时实际执行。先按 1 个 worker 起步，测量后再评估 2 个。
- 测试供应商地址：`https://copilot.tencent.com/v2/`。
- 用户指定的协议名：`openai-completions`；模型：`hy4`。
- 本机测试凭证保存在仓库外的 `~/.config/conest/model-test.env`，权限为 `0600`。读取其中的 `CONEST_TEST_API_KEY`，不要输出密钥，不要复制进代码、文档、测试快照或版本控制。
- 该文件供测试显式读取，现有 CoNest / DSH 不会自动加载它；DSH 的供应商配置仍需单独接入。
- 2026-11-17 直接 HTTP 冒烟测试：`POST /v2/chat/completions` 必须使用 `stream: true`；非流式返回 HTTP 400、业务码 `11101`。流式函数调用及工具结果往返成功，服务端返回的模型标识为 `hy4-ioa`，请求仍使用 `hy4`。
- 很小的 `max_tokens` 会被推理 token 耗尽：测试中 64 token 得到 `finish_reason: length` 且无正文；1024 token 上限下，最小工具往返得到正文 `OK`。这不是实际任务的输出额度或性能基准。
- N100 Ubuntu 当前 Node `v18.19.1`、pnpm `10.2.1`、Git `2.43.0`；前两者低于项目要求。`scripts/setup-n100-toolchain.sh` 在用户私有目录安装固定 Node `v24.22.3` / pnpm `11.7.0`，校验官方 Node SHA256，不改系统 Node 或 shell 启动文件。实际执行容量仍待真机测试。
- 微信优先参考腾讯官方 `Tencent/openclaw-weixin` 的账号绑定与 iLink 传输，实现独立 DSH Source；该插件依赖 OpenClaw，不能直接当 DSH 插件安装。官方多账号支持不等于已证明单机器人多人或群协作，须先验证真实路径。
- M0 已实现独立命令 `pnpm m0 model/login/weixin/status/doctor`，先 `pnpm build`。真实 DSH kernel、Agent Loop、pi-ai 和 JSONL persistence 使用 `0.2.1-alpha.2`；模型探针完成 2 次模型请求和 1 次工具调用，输出 `OK`。
- 用户已扫码绑定并发送微信测试消息，程序经 DSH/hy4 回复，用户确认手机收到。用户当前没有第二个微信账号，真实双账号验证暂缓；N100 现场运行尚未完成。M0 仅接受扫码 owner 本人的文本私聊，只开放无副作用工具，每条消息一个新 Session；它不创建 Ticket，也不注册生产 Source。运行细节见 `docs/conest/m0.md`。

开发方案见 [CoNest 多用户开发方案](docs/conest/development-plan.md)。其中的阶段与接口是设计提案，落地前不能描述成现有能力。现状以 [README](README.md)、[架构决定](docs/conest/architecture.md) 和 [安全说明](SECURITY.md) 为准。

- 后续已实现 `src/sources/weixin.ts` 单 owner 文本私聊 Source，走原有 Store/Engine/Ticket/Attention/outbox。`src/ingress/messages.ts` 已替换抛错桩，契约通过；没有引入第二个工单库。
- 主 Runtime 已允许明确禁用 GitHub，跳过其账号/仓库探测；禁用时 GitHub 命令拒绝借用 ambient 凭证。`pnpm weixin:setup` 只初始化新状态目录，配置微信绑定身份与单 worker；部署见 `docs/conest/weixin-runtime.md`。
- 旧单 owner 微信模式不能换 owner 后复用旧 Session；多成员模式在后续迭代中接入，见末条。示例 profile 只开放工单工具，不提供宿主 shell/文件工具，默认上游 OS 权限预设不因此改变。
- 单 owner 阶段回归为 1251 项测试通过，类型检查/构建通过。真实主 Runtime 的 hy4 曾在 4096 token 上限下因输出额度耗尽未建单，后续使用 16384 上限和更长评估期限后已建单、worker ready、工单 completed、outbox sent；用户确认收到完整清单；不要把 M0 的 2048 token 探针配置照搬为主 Runtime 容量。主链路见仓库外私有 runtime-evidence.json，测试进程已停止。

- 新构建在开发机的 Runtime 重启恢复检查通过：completed 工单及 sent 回执保留、effects 为空、无 GitHub setup 错误。`.artifacts/conest-weixin-source.tar.gz` 不含密钥/状态。N100 设备与工具链输出已取得，接下来在 Ubuntu 升级私有工具链并安装构建，步骤见 `docs/conest/n100-wsl.md`；尚未完成真机运行验收。

- 用户已授权提交代码并构建 Docker 发布到私有仓库 Release。`v0.1.0-m0.1` 已发布，代码为 `45f9594b06426558ccc88d48c6cc5fc695172bf1`，地址 `https://github.com/cc8887/CoNest/releases/tag/v0.1.0-m0.1`。6 个附件含 linux/amd64 Docker 归档（327218144 字节）、源码、Compose、模型配置模板、部署说明及 SHA256SUMS；镜像不含真实凭证或私聊。
- Docker 的 Linux CI 已通过 1251 项测试、架构与非 root 检查、只读根文件系统/noexec 临时目录下的主 Runtime 启动和重启。最终采用 Linux host 网络，保留 SuperAgent 管理层的回环监听要求；Docker Desktop 需要启用 host networking。原生加载器设置 `NARB_DISABLE_NATIVE_CACHE=1`，从只读镜像加载原生库。不要把它改回 wildcard 管理监听或从 noexec /tmp 加载动态库。部署见 `docs/conest/docker.md`，N100/Windows/Podman 的现场运行仍待验收。

- 用户强调目标是通用多用户，不能按双用户专用方案实现。初次本地审计使用旧版本时，10 位模拟发送者只有 owner 被接收，其余被拒绝；这个结论已由后续成员模式取代，旧单 owner 行为保留兼容。通用飞书 100 工单调度回归保留，不能代替微信成员隔离验收。
- 最新源码已实现 `src/app/members.ts`：同一 Store 的 Source 设置保存成员目录，KV 保存不可改绑的 bot/owner/member、消息归属与稳定私有 router id。工单归属从原 Trigger 派生，不另建任务库。候选相关工单、列表分页、单资源读取、工具参数和异步返回均经宿主检查；报告/Attention/追问按所属成员路由。成员模式所有受管理 Session 禁用继承 shell/文件/子 Agent 与全局设置工具，单 worker 上限也覆盖人类追问。OS 预设仍为 danger-full-access，不是代码执行沙箱。
- `pnpm weixin:setup --members-file <absolute-json> --state-dir <fresh-state>` 可初始化任意配置数量的成员（测试 10 位），格式见 `examples/weixin.members.json`。账号必须匹配凭证中的 bot id/owner id；每个 bot 仍只收其扫码 owner，不开放陌生人或群。旧单 owner 有历史时必须使用新状态目录，不能把旧共享 Session 导入成员模式。同一 bot/owner 不能改绑另一个成员，停用后保留历史归属。本次源码容器入口新增 `init-members`；已发布 M0.1 镜像仍为旧版本。
- 当前 `pnpm check` 类型检查/构建通过，1259 项测试通过。`pnpm test:local-mock` 在真实 DSH CLI/Loop/pi-ai/Session/主 Runtime 中，用 mock 微信与 OpenAI SSE 模型验证 10 个成员、100 张工单：1 运行/99 排队时重启并保留全部工单；100 张最终 completed，10 次定向追问和续接，210 次原账号投递，完成后重启不重发；逐模型请求检查成员正文、账号与任务标记，真实工具调用拒绝跨成员读，100 份报告和回执与原工单匹配。`tests/weixin-members.spec.ts` 另覆盖越权写入、停用/异步撤销、单账号故障和严格共享槽位。未使用真实凭证、不需要扫码，不证明 10 个真实账号或 N100 性能。见 `docs/conest/weixin-runtime.md`。

- 用户最新澄清：**每位成员就是一个独立租户**，不能把家庭/团队作为当前租户，再在租户内划分多位成员。术语见根目录 `CONTEXT.md`。
- 当前源码新增网页成员注册和独立个人空间。平台管理员登录 DSH，在 Superagent → 来源 → 成员注册与微信绑定创建成员，异步生成二维码；扫码/PIN 后宿主自动私有保存凭证并原子提交账号关联、允许名单与成功状态，无需导出或手改配置。`pnpm weixin:setup --web --state-dir <fresh-state>` 初始化空成员目录；当前源码容器首次 start 自动执行该初始化，旧初始化方式保留兼容。
- 每位成员有独立 `/t/<memberId>/` 个人页面，可提交工单、查看本人结果、回复追问、停止/重试。默认个人服务 `127.0.0.1:3089`，DSH 管理端 `127.0.0.1:3088`；管理接口检查实际 Connection 签名浏览器会话，个人端使用独立凭据和宿主范围检查。个人链接一天内有效、仅一次兑换；登录 30 天，Cookie HttpOnly / SameSite Strict，HTTPS 下 Secure。只存令牌摘要；停用后撤销全部登录。远程个人端需可信 TLS 或 HTTPS 代理；只代理个人服务并保留 Host，不能把 DSH 管理端公开。参数见 `docs/conest/weixin-runtime.md` 和 ADR 0001。
- 网页迭代 `pnpm check`：1265 项测试通过、类型检查与构建通过。真实 DSH 本地 mock 默认从网页创建 10 个个人租户并模拟扫码绑定，验证凭证和允许名单、一次性链接与跨租户拒绝，再完成 100 工单的共享队列、重启、私有上下文、报告/回执核对；个人接口各返回本人 10 个结果。Chrome 另验证创建第 11 位模拟成员、扫码状态变更、个人链接兑换、网页提交工单完成、结果弹窗和 390px 手机布局。未使用真实凭证，不证明新的网页流程已在真实手机/多个真实微信账号或 N100 上验收。旧 M0.1 Release 仍为原版本。

- 网页收尾复测曾有一次原生 mock 回执关联断言 `0 !== 1`，失败日志为忽略目录 `.artifacts/portal-native-final.log`；当时未保留临时状态，不能把后续通过当作已定位根因。补充了错误堆栈和每工单回执断言；随后连续 7 轮 10 租户/100 工单通过（包括两个带 37ms 调度扰动的原生进程）。另修正 mock SSE response id 在异步处理中读取全局计数可能重复的问题，固定为请求自己的序号；尚未证明该问题导致之前断言。此待复现项需在后续发布验收继续跟进，不宣称已修复生产回执缺陷。模拟进程和私有临时状态已清理，保留脱敏日志、报告与页面截图。
