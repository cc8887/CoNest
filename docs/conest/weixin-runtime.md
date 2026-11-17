# 微信主 Runtime 部署与验证

日期：2026-11-17。当前开发代码支持多个显式绑定成员的文本私聊，成员各有私有路由 Session，复用同一 SuperAgent Store、Engine、Ticket、Attention、effects、outbox 和 worker 队列。可以禁用 GitHub。`v0.1.0-m0.1` 发布附件仍为旧单 owner 版本，以下成员功能需使用本次源码构建。

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

该命令只接受新数据库，禁用 GitHub/飞书，配置 hy4、1 个 worker 和 600 秒评估超时。它不需要先扫码、导出凭证或填写成员 JSON。重新启动直接使用现有状态；已有旧单 owner 私聊历史需保留原目录，另建成员状态和 DSH profile。

## 网页注册、扫码与个人空间

每位成员就是一个独立租户；平台管理员管理成员，成员进入自己的个人空间。按下一节安装、配置并启动 DSH 后：

1. 管理员打开启动日志中的带凭据管理地址，完成认证后直接进入 **CoNest 后台 → 成员与微信**。模型与执行等高级设置可通过侧栏“高级控制台”打开；其地址为 `/index.html`，仍要求管理员认证。
2. 填写成员名称并创建。网页自动生成该成员的微信绑定二维码和一次性个人访问链接。
3. 让对应成员用本人微信扫码，并在微信里确认。如要求 PIN，直接填绑定网页；也可先把个人访问链接交给成员，让其在自己的“微信连接”页完成扫码/PIN。
4. 状态变为“微信已绑定”后，凭证已自动私有保存，账号与成员关联、允许名单一并提交。无需导出文件、编辑配置或重启 Runtime。
5. 将个人访问链接只交给对应成员。链接一天内有效、仅能使用一次；首次打开后由 HttpOnly Cookie 保持登录 30 天。链接使用后请收藏不含 `#invite` 的个人页面。换浏览器或退出后可由管理员生成新链接；新链接不撤销其他已有登录，停用成员会撤销全部登录。

个人空间提供自己的任务列表、进度和结果、提交任务、回复追问、停止与重试。网页与微信共享成员身份、私有 router 和原有工单；所有成员共用一个 Engine、Store 与 worker 队列。一个 bot 仍只接受其扫码 owner 的文本私聊，不接陌生人或群。同一 bot/owner 不能关联到另一个成员；重新授权由平台管理员发起，失败时保留原绑定。

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

本次开发机验证使用 DSH CLI、kernel 与 pi-ai 的 `0.2.1-alpha.2`。上游旧安装说明中的 rc.3 不是本次验证版本。以下采用私有安装目录：

```sh
npm install --prefix "$HOME/.local/share/conest/dsh-alpha" --ignore-scripts @deepseek-ai/dsh@0.2.1-alpha.2
export DSH_HOME="$HOME/.local/share/conest/dsh-home"
export PATH="$HOME/.local/share/conest/dsh-alpha/node_modules/.bin:$PATH"
dsh --profile conest --from-default-profile web --dump-config > /dev/null
dsh plugin --profile conest add "link:$PWD"
```

创建命令要求尚未存在的 profile 名。确认 `$DSH_HOME/profiles/conest/package.json` 的 `dsh.profile.bundles` 包含以下三个条目；安装命令未自动加入时手工补上最后一个，保留其他设置：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-superagent"]
```

将[微信 profile 示例](../../examples/weixin.profile.cordis.patch.yml)复制为该 profile 的 `cordis.patch.yml`，将 `stateDir` 替换为初始化时的绝对路径。不要覆盖已有生产 profile。示例只有文本输入和 SuperAgent 工单工具；worker/router 的 `plugins: []` 不加载宿主 shell、文件或子 Agent 工具。完整 preset 配置必须保留 `id` 和 `name`。

供应商使用 `openai-completions`、`hy4` 和环境变量 `CONEST_TEST_API_KEY`。DSH pi-ai 使用流式请求；接口不接受本次所测非流式请求。主 Runtime 的提示词和工具远多于 M0：4096 token 曾在调用建单工具前被耗尽，因此示例将输出上限设为 16384；初始化使用 600 秒评估期限，避免把较长的模型推理误判为 120 秒评估超时。输出额度是上限而非每次消耗保证，也不是完整的费用预算控制。原有部署需在管理面板的 eval 设置中调整超时，初始化命令不会覆盖它。

在源码目录启动：

```sh
umask 077
node --env-file="$HOME/.config/conest/model-test.env" \
  "$HOME/.local/share/conest/dsh-alpha/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile conest --no-open
```

`DSH_HOME` 和 `PATH` 需在当前终端生效；新终端重新设置。DSH 启动输出的管理地址含本机访问凭据，按私有信息保存。管理端仅监听 `127.0.0.1:3088`，个人端默认 `127.0.0.1:3089`。先在网页创建成员并扫码绑定，检查 Runtime 与微信健康为 ready、GitHub setup 无错误，再向已绑定机器人发送：

```text
请创建工单，生成三条测试清单：身份校验、任务执行、结果回传。完成后通过工单报告，把清单发回微信。
```

验收需同时核对：原私聊已入站、模型调用 `orchestrator_route` 建单、独立 worker 调用 `orchestrator_report`、主 Session 调用 `orchestrator_reply`、outbox 标记发送，以及手机实际收到。worker 的报告先进入主 Session，不会绕过主 Session 直接发微信。停止使用 `Ctrl+C`，等待轮询取消和 Store 关闭后再迁移或启动其他实例。

## 本地 mock 验收（2026-11-17）

验收使用 10 位成员、总计 100 个未完成任务且允许排队。实现由成员目录驱动，不限定为双用户。

执行 `pnpm test:local-mock`。它使用已安装的 DSH CLI `0.2.1-alpha.2`，默认路径为 `~/.local/share/conest/dsh-alpha/node_modules/@deepseek-ai/dsh/lib/bin.js`；其他路径用 `CONEST_MOCK_DSH_BIN` 指定。需要项目支持的 Node 版本。该命令先构建，然后创建独立的临时 DSH profile、凭证文件、Session 和 SQLite 数据库，不使用已有微信或模型凭证，也不要求扫码。

测试启动真实本机 DSH CLI、Session、Agent Loop、pi-ai 和主 Runtime，保留原有 Store、Engine、Ticket、Attention、effects 与 outbox。默认先通过真实管理 HTTP 接口创建 10 个个人租户，模拟扫码确认，检查凭证私有保存、允许名单、一次性链接与跨租户登录拒绝；完成后运行 100 工单。仅在外部接口处替换输入：`tests/fixtures/weixin-offline-plugin.mjs` 通过文件模拟 iLink 收发，模型端是回环 HTTP 服务，按 OpenAI SSE 协议返回确定性的工具调用。这不是本轮真实 hy4 推理或手机收信证明。

默认自动停止进程并删除临时状态，只留下 `.artifacts/mock-runtime-report.json`。排查调度问题可设置 `CONEST_MOCK_JITTER_MS=37` 给模拟模型响应加入确定性的请求延迟扰动。设置 `CONEST_MOCK_KEEP=1` 可保留合成数据供调试；该目录包含本机管理访问凭据，勿共享。普通 `pnpm check` 不依赖额外安装的 DSH CLI；100 工单的调度回归在普通测试内运行。

| 场景 | 本地实测结果 | 能证明什么 |
| --- | --- | --- |
| 网页创建 10 位成员并模拟扫码，各自独立租户 | 10 个稳定私有 router，100 个工单 | 同一部署中的通用多成员绑定 |
| 每次实际模型请求检查私有正文和身份 | 每次只含本成员内容和账号标识 | 真实 DSH 的上下文隔离；模型回复为脚本 |
| 1 个 worker 运行、99 个排队时重启 | 100 个原工单与队列恢复 | 真实 Runtime/SQLite 与 DSH Session 恢复 |
| 10 次 worker 提问 → 私聊追问 → attach 原工单 → ready → 结果 | 全部通过，其余 90 个工单直接完成 | 定向 Attention、追问与原账号结果回传 |
| 全部投递与完成后再次重启 | 100 个 completed、210 次 mock 投递，重启不重复发送 | 接单、提问和结果的账号范围及回执恢复 |
| 每个个人页面读取自己的 10 个结果 | 共 100 个，其他成员标记不出现 | 个人页面接口的数据范围 |
| 模型猜另一成员的工单 id | 真实 DSH 工具调用返回 inaccessible | 宿主权限拒绝，不依赖模型守约 |
| 停用成员、跨成员 attach/stop/report、账号改绑、单账号故障 | 集成回归覆盖；其他账号可继续轮询 | 工具写入、状态变更、撤销和传输故障隔离 |

单独运行 `pnpm exec vitest run tests/weixin-members.spec.ts` 可验证成员权限和共享队列；其中 DSH agents 是替身。`pnpm test:local-mock` 则运行真实 DSH，先积压 100 个工单、在队列中途重启，再完成所有工单并逐条核对投递。回传由 mock iLink 捕获，模型为本地 OpenAI SSE 脚本；未据此声称 10 个真实微信账号、真实 hy4 并发性能或 N100 容量已经验收。旧的 `tests/multiuser-readiness.spec.ts` 保留旧单 owner 的兼容性与通用调度回归。

本次收尾曾出现一次回执关联断言失败，临时状态当时未保留，尚未定位根因。增加诊断信息后连续 7 轮通过，其中两轮有模型响应调度扰动。mock SSE 的响应 id 已固定为每请求唯一；目前不能证明它与先前失败的因果关系。此记录保留为后续发布验收待复现项，不将重复通过描述为该故障已修复。

## 恢复与边界

- Trigger 与游标在原 Store 同一事务提交，重复轮询不重复创建 Trigger；回复 context 只在宿主私有 KV 中保存。
- 成员模式下私聊跟进由私有 router attach 到原工单；旧单 owner 模式保留订阅自动续接。Attention 与结果经原 outbox 回到有权限的绑定私聊。群、陌生人、多媒体和缺少回复上下文的消息不产生任务。
- 发送分段有稳定客户端 id。本地 `sending` / `uncertain` 状态阻止盲目重发；网络错误不等于手机未收到。先核实手机，再由操作者处理投递记录，当前没有自动修复不确定回执的命令。
- 凭证文件轮询锁是同主机同路径的租约；无法阻止另一台机器或复制凭证后的另一路径轮询。迁移前明确停止旧实例。
- 模型输出额度耗尽、供应商错误或评估超时可在 Session 和管理面板查看；修复配置后重启，再重新评估原 Trigger。不要删除已有数据库来掩盖失败。
- 权限预设仍为上游的 `danger-full-access`，没有 OS 沙箱。成员模式由宿主限制为工单工具并检查范围；不提供任意 shell、文件或子 Agent 执行。成员记忆共享、工单共享与群授权仍为后续能力。

## 验证记录

当前完整检查结果见项目记忆；网页接口回归另覆盖 PIN、过期二维码刷新、停用后登录失效、跨租户操作拒绝和未完成扫码恢复。早期单 owner 基线为 1251 项通过。主 Runtime 集成测试覆盖无 GitHub 启动、真实 Engine 建单、追问/续接/完成、原私聊 outbox、去重、游标事务回滚、旧消息重放和绑定修改保护。

开发机真实 DSH/hy4 主 Runtime 已在 GitHub 禁用时完成：用户微信入站 → 模型调用 orchestrator_route → 一个真实 Ticket → 独立 worker 调用 orchestrator_report ready → 工单 completed → 主 Session 调用 orchestrator_reply → 接单与结果 outbox 均 sent、effects 清空。用户确认手机收到完整的三项清单，测试进程已停止。初次 4096 token 额度失败及后续重新评估的记录保留在私有 DSH Session，没有删除失败来替代验收。该次链路有数分钟模型推理延迟，只证明功能闭环；响应时间与模型费用仍需优化。M0 证据另行保留。

新构建的开发机 Runtime 重启检查也通过：无 GitHub 启动正常，已完成工单和 sent 回执保留，effects 为空，检查进程已停止。这不是 Windows/WSL 或整机重启验收。

Docker `v0.1.0-m0.1` 已在 [GitHub Release](https://github.com/cc8887/CoNest/releases/tag/v0.1.0-m0.1)发布。Linux/amd64 CI 验证了镜像构建、1251 项测试、非 root 与只读配置、无真实渠道流量的主 Runtime 启动和容器重启；附件校验值已核对。具体网络与数据卷要求见 [Docker 部署](docker.md)。这仍不替代 N100 的实机收件、容量和 Windows 生命周期验收。

N100 已确认 Windows 11 专业版 `10.0.26200.9974`、15.8 GB 内存、WSL `2.7.14.0`、Ubuntu WSL2/x86_64。当前 Node `18.19.1` 与 pnpm `10.2.1` 需先升级私有工具链。真机运行、常驻与重启恢复、100 个未完成任务的容量尚未实测。用户暂无第二个微信账号，真实双账号验收暂缓。
