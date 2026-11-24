# 微信主 Runtime 部署与验证

日期：2026-11-19。当前代码支持多个显式绑定成员的文本私聊，成员各有私有前台路由 Session，复用同一 SuperAgent Store、Engine、Ticket、Attention、effects、outbox 和 worker 队列。新成员模式默认用 `hy4-flash` 陪聊、单个共享 `hy4` worker 执行工单。`v0.2.0-alpha.2` Release 包含此体验与成员个人网页；`v0.1.0-m0.1` 发布附件仍为旧单 owner 版本。以下为源码部署流程，容器可按对应 Release 的 DOCKER.md 部署。

## 准备源码与私有状态

在开发机或 N100 的 Ubuntu WSL2 内使用符合 `package.json` 的 Node.js 与 pnpm `11.7.0`。源码和状态放在 Linux 文件系统；不要从开发机复制 `node_modules` 或原生编译产物。

N100 已报告 Node 18 与 pnpm 10，需先按 [N100 现场步骤](n100-wsl.md)安装私有工具链，再执行下面的构建流程。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm m0 doctor
```

先停止针对同一 bot 的 M0 / 主 Runtime 轮询进程。模型凭证仍使用仓库外的 `~/.config/conest/model-test.env`，变量见 [M0 文档](m0.md)，权限为 `0600`。

为网页注册创建新的空成员状态：

```sh
pnpm weixin:setup --web \
  --state-dir "$HOME/.local/state/conest/runtime-members" \
  --provider conest --model hy4
```

该命令只接受新数据库，禁用 GitHub/飞书。新成员模式默认用 `hy4-flash` 处理前台会话，用 `hy4` 运行后台工单。全平台共享 1 个 worker，评估超时为 600 秒。它不需要先扫码、导出凭证或填写成员 JSON。重新启动直接使用现有状态。旧单 owner 迁到成员模式时，需要另建成员状态和 DSH profile。

## 微信前台对话与后台工单

每位成员在微信里有一个持续保留上下文的私有前台会话。问候、闲聊和能当场回答的简单问题直接发回微信。明确委托工作或要求交付成果时，前台发送接单回执，并将工单交给独立 worker 会话。后台运行时，可以继续在同一个私聊里对话。前台回复无需占用 worker，工单结果仍回到原账号。

既有成员部署可在 DSH profile 的供应商模型列表中补上 `hy4-flash`，重启后在 CoNest 后台的「评估 → 研判模型」选择它。在「执行」中确认执行器模型为 `hy4`、并行 worker 数为 1。已有私有前台会话收到下一条消息时会应用已保存的研判设置，并保留对话历史。新部署也可以用 `--router-model` 和 `--model` 分别指定前台和执行模型。

## 性能

平台管理员在 CoNest 后台左侧进入「性能」。页面按会话角色和模型汇总最近 24 小时或 7 天的样本数、P50、P95 和有明确成功或失败结果的指标的失败率。

| 指标 | 计时范围 |
| --- | --- |
| 微信问答响应 | CoNest 收到消息到微信接口确认首条直接答复。失败率的分母是已经排入发件箱并完成投递或被丢弃的直接答复。 |
| 首 token | DSH 开始单次模型流到收到第一个正文、推理或工具调用片段。 |
| 推理输出 | 主机收到首末推理片段之间的时间。模型没有返回推理片段时，这项没有样本。 |
| 模型调用与重试 | DSH 开始单次模型流到其结束。同一步重新发起的流也计入模型重试，超时、错误、取消和额度用尽计作失败。 |
| 前台与工单排队 | 微信消息入站到被前台模型步骤取用，以及工单进入调度到 worker 接手。 |
| 微信投递与发送尝试 | 发件箱入队到微信确认或终止投递，包含退避。发送尝试另按每次通道调用计时，因此可看到后续成功的重试。 |

问答响应是服务端到微信接口的时间，手机显示答复需要另行测量。P50 和 P95 采用最近秩法，已标记失败的耗时仅参与样本数和失败率。数据从升级后开始采集，超过 7 天的样本每小时清理一次。指标只保存时间、角色、模型、状态和必要的去重键，无聊天正文、提示词、推理文本或成员标识。

## 网页注册、扫码与个人空间

每位成员就是一个独立租户；平台管理员管理成员，成员进入自己的个人空间。按下一节安装、配置并启动 DSH 后：

1. 管理员打开启动日志中的带凭据管理地址，完成认证后直接进入 **CoNest 后台 → 成员与微信**。模型与执行等高级设置可通过侧栏“高级控制台”打开；其地址为 `/index.html`，仍要求管理员认证。
2. 填写成员名称并创建。网页自动生成该成员的微信绑定二维码和一次性个人访问链接。
3. 让对应成员用本人微信扫码，并在微信里确认。如要求 PIN，直接填绑定网页；也可先把个人访问链接交给成员，让其在自己的“渠道连接”页完成扫码/PIN。
4. 状态变为“微信已绑定”后，凭证已自动私有保存，账号与成员关联、允许名单一并提交。无需导出文件、编辑配置或重启 Runtime。
5. 将个人访问链接只交给对应成员。链接一天内有效、仅能使用一次；首次打开后由 HttpOnly Cookie 保持登录 30 天。链接使用后请收藏不含 `#invite` 的个人页面。换浏览器或退出后可由管理员生成新链接；新链接不撤销其他已有登录，停用成员会撤销全部登录。

个人空间提供自己的任务列表、进度和结果、提交任务、回复追问、停止与重试。网页与微信共享成员身份、私有 router 和原有工单；所有成员共用一个 Engine、Store 与 worker 队列。一个 bot 仍只接受其扫码 owner 的文本私聊，不接陌生人或群。同一 bot/owner 不能关联到另一个成员；重新授权由平台管理员发起，失败时保留原绑定。

绑定私聊和个人网页可用自然语言创建、查看自己的[定时任务](schedules.md)；飞书群需另外启用并绑定，不影响微信仅收私聊的边界。

平台管理页路径为 `/orchestrator/registration/`，必须持有 DSH 签名浏览器会话；个人链接不能访问管理接口。成员停用后，已有网页登录、后续输入、工具和投递均会被拒绝，历史归属保留。管理页仅在本机使用。

### 让其他设备访问个人页面

默认个人服务为 `http://127.0.0.1:3089`，仅供本机验证；默认生成的链接不能直接在其他手机或电脑访问。DSH 管理端仍为回环 `3088`。个人服务与 DSH 必须保持独立 Origin。

在 DSH profile 的 `dsh-superagent` 配置中可设置以下参数，修改后重启：

| 配置 | 默认值与用途 |
| --- | --- |
| `portalHost` | `127.0.0.1`；仅允许具体 IP，拒绝 wildcard |
| `portalPort` | `3089`；个人服务端口 |
| `portalOrigin` | 空；外部个人页面的 HTTPS Origin，例如 `https://conest.example.com`，不带路径或结尾斜线 |
| `portalTlsCertFile` / `portalTlsKeyFile` | 空；可直接为具体局域网 IP 的监听提供证书和私钥。非回环监听必须启用 TLS |

也可保持个人监听在 `127.0.0.1:3089`，由 HTTPS 反向代理只转发该端口，并设置 `portalOrigin` 为该 HTTPS 域名。代理必须保留外部 Host，服务会精确校验 Host/Origin；不要转发 DSH 的 `3088`。使用可被成员设备信任的证书，个人 Cookie 在 HTTPS 下带 Secure。配置外部地址后，重新生成个人访问链接。N100 上的代理、WSL 转发与设备访问仍需现场配置和验证。

## 兼容命令行初始化

已有私有凭证可使用 `--credentials-file <absolute-file>` 初始化旧单 owner 模式；已有成员清单可使用 `--members-file <absolute-json>` 初始化成员模式，格式见 [示例](../../examples/weixin.members.json)。这些参数与 `--web` 三选一。凭证中的账号/owner 必须匹配清单，旧单 owner 历史不能原地导入成员模式。

从当前源码构建的容器在首次 `start` 时自动初始化空网页注册状态；已有数据库原样恢复。旧 `init` / `init-members` 命令继续保留。已发布的 M0.1 镜像不包含网页流程，不要用旧附件验证这些功能。

## 安装与配置 DSH

当前源码的 DSH CLI、kernel 与 pi-ai 均固定为 `0.2.2-rc.5`。源码部署与容器构建共用 CLI 锁文件。

```sh
npm ci --prefix containers/dsh --ignore-scripts
export DSH_HOME="$HOME/.local/share/conest/dsh-home"
export PATH="$PWD/containers/dsh/node_modules/.bin:$PATH"
dsh --profile conest --from-default-profile web --dump-config > /dev/null
dsh plugin --profile conest add "link:$PWD"
```

创建命令要求尚未存在的 profile 名。确认 `$DSH_HOME/profiles/conest/package.json` 的 `dsh.profile.bundles` 包含以下三个条目；安装命令未自动加入时手工补上最后一个，保留其他设置：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-superagent"]
```

将[微信 profile 示例](../../examples/weixin.profile.cordis.patch.yml)复制为该 profile 的 `cordis.patch.yml`，将 `stateDir` 替换为初始化时的绝对路径。不要覆盖已有生产 profile。示例只有文本输入和 SuperAgent 工单工具；worker/router 的 `plugins: []` 不加载宿主 shell、文件或子 Agent 工具。完整 preset 配置必须保留 `id` 和 `name`。

供应商使用 `openai-completions`，示例声明 `hy4-flash` 和 `hy4`，凭证来自环境变量 `CONEST_TEST_API_KEY`。DSH pi-ai 使用流式请求。旧版主 Runtime 曾在 4096 token 上限内耗尽额度，因此示例将输出上限设为 16384，初始化使用 600 秒评估期限。既有部署的超时时间可在管理面板的评估设置中调整。

在源码目录启动：

```sh
umask 077
node --env-file="$HOME/.config/conest/model-test.env" \
  "$PWD/containers/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile conest --no-open
```

`DSH_HOME` 和 `PATH` 需在当前终端生效；新终端重新设置。DSH 启动输出的管理地址含本机访问凭据，按私有信息保存。管理端仅监听 `127.0.0.1:3088`，个人端默认 `127.0.0.1:3089`。先在网页创建成员并扫码绑定，检查 Runtime 与微信健康为 ready、GitHub setup 无错误，再向已绑定机器人发送：

```text
请创建工单，生成三条测试清单：身份校验、任务执行、结果回传。完成后通过工单报告，把清单发回微信。
```

验收需同时核对：原私聊已入站、模型调用 `orchestrator_route` 建单、独立 worker 调用 `orchestrator_report`、主 Session 调用 `orchestrator_reply`、outbox 标记发送，以及手机实际收到。worker 的报告先进入主 Session，不会绕过主 Session 直接发微信。停止使用 `Ctrl+C`，等待轮询取消和 Store 关闭后再迁移或启动其他实例。

## 本地 mock 验收

验收使用 10 位成员、总计 100 个未完成任务且允许排队。实现由成员目录驱动，不限定为双用户。

先执行 `npm ci --prefix containers/dsh --ignore-scripts`，再执行 `pnpm test:local-mock`。它默认从 `containers/dsh/node_modules` 加载锁定版本的 DSH CLI；其他路径用 `CONEST_MOCK_DSH_BIN` 指定。需要项目支持的 Node 版本。该命令先构建，然后创建独立的临时 DSH profile、凭证文件、Session 和 SQLite 数据库，不使用已有微信或模型凭证，也不要求扫码。

测试启动真实本机 DSH CLI、Session、Agent Loop、pi-ai 和主 Runtime，保留原有 Store、Engine、Ticket、Attention、effects 与 outbox。默认先通过真实管理 HTTP 接口创建 10 个个人租户，模拟扫码确认，检查凭证私有保存、允许名单、一次性链接与跨租户登录拒绝；完成后运行 100 工单。仅在外部接口处替换输入：`tests/fixtures/weixin-offline-plugin.mjs` 通过文件模拟 iLink 收发，模型端是回环 HTTP 服务，按 OpenAI SSE 协议返回确定性的工具调用。这不是本轮真实 hy4 推理或手机收信证明。

默认自动停止进程并删除临时状态，只留下 `.artifacts/mock-runtime-report.json`。排查调度问题可设置 `CONEST_MOCK_JITTER_MS=37` 给模拟模型响应加入确定性的请求延迟扰动。设置 `CONEST_MOCK_KEEP=1` 可保留合成数据供调试；该目录包含本机管理访问凭据，勿共享。普通 `pnpm check` 不依赖额外安装的 DSH CLI；100 工单的调度回归在普通测试内运行。

| 场景 | 本地实测结果 | 能证明什么 |
| --- | --- | --- |
| 网页创建 10 位成员并模拟扫码，各自独立租户 | 10 个稳定私有 router，100 个工单 | 同一部署中的通用多成员绑定 |
| 每次实际模型请求检查私有正文和身份 | 每次只含本成员内容和账号标识 | 真实 DSH 的上下文隔离；模型回复为脚本 |
| 1 个 worker 运行、99 个排队时重启 | 100 个原工单与队列恢复 | 真实 Runtime/SQLite 与 DSH Session 恢复 |
| 同一微信账号在其 worker 运行时连续聊三轮 | 三条回复均先于工单完成，闲聊没有新增工单 | 前台模型为 `hy4-flash`，被挂起的后台模型请求为 `hy4`，随后在原账号收到结果 |
| 10 次 worker 提问 → 私聊追问 → attach 原工单 → ready → 结果 | 全部通过，其余 90 个工单直接完成 | 定向 Attention、追问与原账号结果回传 |
| 全部投递与完成后再次重启 | 100 个 completed、210 次 mock 投递，重启不重复发送 | 接单、提问和结果的账号范围及回执恢复 |
| 每个个人页面读取自己的 10 个结果 | 共 100 个，其他成员标记不出现 | 个人页面接口的数据范围 |
| 模型猜另一成员的工单 id | 真实 DSH 工具调用返回 inaccessible | 宿主权限拒绝，不依赖模型守约 |
| 停用成员、跨成员 attach/stop/report、账号改绑、单账号故障 | 集成回归覆盖；其他账号可继续轮询 | 工具写入、状态变更、撤销和传输故障隔离 |

单独运行 `pnpm exec vitest run tests/weixin-members.spec.ts` 可验证成员权限和共享队列；其中 DSH agents 是替身。`pnpm test:local-mock` 则运行真实 DSH，先积压 100 个工单、在队列中途重启，再完成所有工单并逐条核对投递。回传由 mock iLink 捕获，模型为本地 OpenAI SSE 脚本；未据此声称 10 个真实微信账号、真实 hy4 并发性能或 N100 容量已经验收。旧的 `tests/multiuser-readiness.spec.ts` 保留旧单 owner 的兼容性与通用调度回归。

早先收尾的偶发回执文字断言已复现并定位：mock 模型服务逐个 Buffer 解码 HTTP 请求，中文字符跨块时产生替换字符，随后被脚本模型回传。工单 id 和成员归属一致，数据库报告原文也正确。`scripts/mock-http.mjs` 改为完整拼接后解码；`tests/mock-http.spec.ts` 覆盖所有字节分割位置、逐字节传输和不完整 JSON。该修复针对测试接收端，发布前继续运行真实 DSH 与 Linux 镜像全链路。

## 恢复与边界

- Trigger 与游标在原 Store 同一事务提交，重复轮询不重复创建 Trigger；回复 context 只在宿主私有 KV 中保存。
- 成员模式下私聊跟进由私有 router attach 到原工单；旧单 owner 模式保留订阅自动续接。Attention 与结果经原 outbox 回到有权限的绑定私聊。群、陌生人、多媒体和缺少回复上下文的消息不产生任务。
- 发送分段有稳定客户端 id。本地 `sending` / `uncertain` 状态阻止盲目重发；网络错误不等于手机未收到。先核实手机，再由操作者处理投递记录，当前没有自动修复不确定回执的命令。
- 凭证文件轮询锁是同主机同路径的租约；无法阻止另一台机器或复制凭证后的另一路径轮询。迁移前明确停止旧实例。
- 模型输出额度耗尽、供应商错误或评估超时可在 Session 和管理面板查看；修复配置后重启，再重新评估原 Trigger。不要删除已有数据库来掩盖失败。
- 权限预设仍为上游的 `danger-full-access`，没有 OS 沙箱。成员模式由宿主限制为工单工具并检查范围；不提供任意 shell、文件或子 Agent 执行。成员记忆共享、工单共享与群授权仍为后续能力。

## 验证记录

`v0.2.0-alpha.2` 发布验收覆盖微信前台陪聊。真实腾讯流式模型配合模拟微信传输时，同一账号在后台 worker 请求挂起期间收到了三轮连续回复；之后放行 `hy4` worker，工单完成并回传。Linux/amd64 镜像中的真实 DSH 与 mock 模型/iLink 回归覆盖 10 个租户、100 张工单和 worker 执行期间三轮陪聊。该模拟传输不证明手机实收、多个真实微信账号或 N100 容量已经验收。

`v0.2.0-alpha.1` 已在 [GitHub Release](https://github.com/cc8887/CoNest/releases/tag/v0.2.0-alpha.1) 发布。源码/镜像 revision 为 `a57f3747cc11804318e581966b7c30d2a8525f60`；Linux CI 通过 1268 项测试、类型检查和构建，镜像通过非 root、只读根/noexec、默认后台与高级入口、认证、个人界面、重启，以及隔绝外网的 10 租户/100 工单/210 次 mock 回传。附件 VALIDATION.json 给出工单与回执核对结果；全部 SHA256SUMS 条目与 GitHub 服务端摘要一致。这不替代真实微信多账号、N100 容量或 Windows/WSL 常驻验收。

当前完整检查结果见项目记忆；网页接口回归另覆盖 PIN、过期二维码刷新、停用后登录失效、跨租户操作拒绝和未完成扫码恢复。早期单 owner 基线为 1251 项通过。主 Runtime 集成测试覆盖无 GitHub 启动、真实 Engine 建单、追问/续接/完成、原私聊 outbox、去重、游标事务回滚、旧消息重放和绑定修改保护。

开发机真实 DSH/hy4 主 Runtime 已在 GitHub 禁用时完成：用户微信入站 → 模型调用 orchestrator_route → 一个真实 Ticket → 独立 worker 调用 orchestrator_report ready → 工单 completed → 主 Session 调用 orchestrator_reply → 接单与结果 outbox 均 sent、effects 清空。用户确认手机收到完整的三项清单，测试进程已停止。初次 4096 token 额度失败及后续重新评估的记录保留在私有 DSH Session，没有删除失败来替代验收。该次链路有数分钟模型推理延迟，只证明功能闭环；响应时间与模型费用仍需优化。M0 证据另行保留。

新构建的开发机 Runtime 重启检查也通过：无 GitHub 启动正常，已完成工单和 sent 回执保留，effects 为空，检查进程已停止。这不是 Windows/WSL 或整机重启验收。

Docker `v0.1.0-m0.1` 已在 [GitHub Release](https://github.com/cc8887/CoNest/releases/tag/v0.1.0-m0.1)发布。Linux/amd64 CI 验证了镜像构建、1251 项测试、非 root 与只读配置、无真实渠道流量的主 Runtime 启动和容器重启；附件校验值已核对。具体网络与数据卷要求见 [Docker 部署](docker.md)。这仍不替代 N100 的实机收件、容量和 Windows 生命周期验收。

N100 已确认 Windows 11 专业版 `10.0.26200.9974`、15.8 GB 内存、WSL `2.7.14.0`、Ubuntu WSL2/x86_64。当前 Node `18.19.1` 与 pnpm `10.2.1` 需先升级私有工具链。真机运行、常驻与重启恢复、100 个未完成任务的容量尚未实测。用户暂无第二个微信账号，真实双账号验收暂缓。
