# CoNest 项目记忆

以下信息由用户在 2026-11-17 指定，后续开发与测试沿用。

- 项目基于 DeepSeek Harness 的 dsh-superagent，目标是部署在 Intel N100 上、支持多用户的 Agent。
- 目标机为 Windows 11 专业版，物理内存报告 15.8 GB，系统版本 `10.0.26200.9974`；WSL `2.7.14.0`、内核 `6.18.33.2-2`、Ubuntu WSL2 / `x86_64`。同机另有 Podman 与 Docker 发行版，先前 Podman 机器正在运行。信息由用户于 2026-11-17 提供。
- 面向小家庭或小团队，约 10 位用户；云端推理；入口优先微信机器人，飞书与网页作为后续入口。
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
- 当前微信主 Runtime 只配置一位绑定 owner，不能换 owner 后复用旧 Session。真实多成员隔离仍未实现；示例 profile 只开放工单工具，不提供宿主 shell/文件工具，默认上游预设权限不因此改变。
- 当前回归检查：`pnpm check` 类型检查/构建通过，1251 项测试通过。真实主 Runtime 的 hy4 曾在 4096 token 上限下因输出额度耗尽未建单，后续使用 16384 上限和更长评估期限后已建单、worker ready、工单 completed、outbox sent；用户确认收到完整清单；不要把 M0 的 2048 token 探针配置照搬为主 Runtime 容量。主链路见仓库外私有 runtime-evidence.json，测试进程已停止。

- 新构建在开发机的 Runtime 重启恢复检查通过：completed 工单及 sent 回执保留、effects 为空、无 GitHub setup 错误。`.artifacts/conest-weixin-source.tar.gz` 不含密钥/状态。N100 设备与工具链输出已取得，接下来在 Ubuntu 升级私有工具链并安装构建，步骤见 `docs/conest/n100-wsl.md`；尚未完成真机运行验收。

- 用户已授权提交代码并构建 Docker 发布到私有仓库 Release。发布目标 `v0.1.0-m0.1`，linux/amd64 镜像作为可 docker load 的附件交付；无本地 Docker 引擎，使用 GitHub Actions 构建与启动/重启检查，通过后再公布预发布。镜像不包含模型或微信凭证。
