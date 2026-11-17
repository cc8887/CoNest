# 安全说明

CoNest 是 dsh-superagent 研究原型的分叉，当前开发代码已实现成员私有路由和宿主工单权限；真实多账号及 N100 现场验收仍待完成。真实家庭凭证、机器人密钥或模型密钥须保存在仓库外。

## 继承的执行权限

未启用成员模式时保留上游执行方式；启用成员模式后有下述工具限制。上游部署文档写明，主 Session 与执行器 Session 以操作者的操作系统用户身份运行，权限预设为 `danger-full-access`：

- `docs/006-deployment.md` 的 “Permissions and isolation”：两种预设都以 `danger-full-access` 作为操作者的 OS 用户运行，并读取已订阅线程中的消息。账号包装脚本默认选择智能体的凭证，并不隔离进程。执行器仍可按绝对路径执行程序，并读取操作者的主目录。上游给出的隔离办法是使用只含智能体凭证的专用 OS 账号。
- `src/app/sessions.ts` 在创建或恢复 Session 时调用 `permissionPresets.set(..., 'danger-full-access')`。
- `docs/003-execution.md`：执行器 Session 不经批准即执行命令。`worker-bin` 里的命令包装和目录只建立默认值，不是安全边界。

`cordis.patch.yml` 里的 `@deepseek-ai/dsh-bash-sandbox` 与 `@deepseek-ai/dsh-pwsh-sandbox` 把前台命令的等待时间限制为 5 秒（`timeoutMs` / `maxTimeoutMs`）。这是原型里的超时配置。本次初始化没有实现、也没有验证操作系统级或家庭成员级的 worker 沙箱。不要把这个插件名理解成 CoNest 已经隔离了执行器。

策略门闩（允许名单、准入表、Mandate）由宿主编译并执行，提示词不能改写这些权限。见 `docs/002-authorization.md` 与 `docs/004-prompts.md`。该门闩按每个 Source 自己的身份工作。它不认识 CoNest 的成员，也不会读取 `src/family`。

## 已实现的成员范围与尚未提供的共享

运行时 `src/app/members.ts` 在原 Store 中保存不可改绑的 bot/owner/member 关联、稳定的私有路由 Session id 和消息归属。成员目录保存在版本化 Source 设置中；工单归属由原始 Trigger 的不可变归属决定。模型不能选择自己的成员身份。工单、Trigger、Thread 和 Decision 的读取及工具写入均经过宿主检查，报告和 Attention 只投递给所属成员。管理面板是持有本机访问凭据的操作者入口，不是成员网页入口。

启用成员模式后，所有受该 Runtime 管理的路由与 worker 都只开放受检查的工单工具，禁用继承的 shell、文件、子 Agent、外部 Source 读取（私有成员）及全局设置工具；即便预设意外加载这些工具，执行 guard 也会拒绝。`prepare` 等宿主配置仍由本机操作者负责。这是当前文本任务的应用权限范围，不是 OS 沙箱；不要据此恢复任意代码执行工具。

- 成员之间的共享记忆或共享工单授权
- 群聊已按成员名单隔离
- 任意 shell/文件操作已在 OS 级按成员隔离

`src/family/authorize.ts` 仍是设计骨架中的纯函数，运行时没有调用它。共享记忆和群成员名单尚未接入；微信 Source 拒绝群消息。

## 网页注册与个人租户

每位成员是独立租户。平台注册接口要求 DSH Connection 的签名浏览器认证，个人 Cookie 和自定义请求头不能获得管理员权限。个人页面由独立监听服务提供，默认 `127.0.0.1:3089`；DSH 管理服务保持回环 `3088`。对外只代理个人服务，不能把 DSH Session、插件或文件接口一并公开。

个人访问链接包含一次性凭据，一天内有效，仅交给对应成员；兑换时从地址栏清除 fragment，数据库只保存凭据摘要。个人登录为 30 天 HttpOnly / SameSite=Strict Cookie，HTTPS 下加 Secure；退出删除当前登录，停用撤销全部登录与未兑换链接。生成新链接不撤销其他已有登录。个人接口校验精确 Host/Origin 和请求头，拒绝跨站请求及访问其他成员的工单。网络监听必须有 TLS，wildcard 监听被拒绝。

网页二维码和 PIN 属于当前成员的绑定授权。PIN 不持久化；API 不返回 bot token、provider ticket 或凭证路径。确认后将凭证以 `0600` 保存到状态目录，并将绑定、允许名单与状态在同一 Store 事务中提交。凭证文件、数据库、DSH 管理访问地址和个人访问链接均为私有信息。

## 凭证与本地状态

M0 已在用户扫码后完成开发机上的微信私聊与真实 DSH 工具调用验证。`src/m0` 使用独立、显式启动的测试入口，只提供无副作用的探针工具，拒绝群、陌生发送者和多媒体；它不启动带宿主 shell / 文件工具的 SuperAgent worker，也不证明普通工单已经具备成员隔离。

测试模型凭证保存在仓库外的 `~/.config/conest/model-test.env`；微信凭证与私聊 Session 保存在仓库外的 `~/.local/state/conest/m0`。目录权限为 `0700`，SQLite 和新建测试文件为 `0600`。它们含有真实凭证或私聊内容，不能提交或混入源码发布包。PIN 由用户直接输入回环地址上的绑定页面，不在聊天中收集。详见 [M0 运行与验证](docs/conest/m0.md)。

最初的仓库初始化没有创建渠道账号或写入密钥；之后的 M0 现场验证已使用用户提供的模型凭证和扫码授权，凭证位置如上。

不要提交：

- DSH 配置文件目录（默认 `~/.dsh`，可用 `DSH_HOME` 改到别处）及其 `stateDir`
- `<stateDir>/orchestrator.sqlite`、`worker-bin/`、`worker-gitconfig/`
- `gh` 的 `GH_CONFIG_DIR`、飞书或 Lark 的 `LARKSUITE_CLI_CONFIG_DIR`，以及其中的应用密钥
- `.env` 和任何真实令牌

`.gitignore` 排除了常见的 SQLite、`.dsh/`、包装脚本目录和密钥文件名。状态目录仍应放在仓库之外；忽略规则不是加密。

[`.env.example`](.env.example) 只列出占位变量名。原型不读取该文件。DeepSeek Harness 的模型供应商配置在它自己的配置文件里，不在这个示例中放密钥。

## 渠道

已随上游导入的渠道是 GitHub，以及默认关闭的飞书 Source。微信、WeChat Claw、iLink 的群能力没有核实，也没有实现。不要把飞书 Source 当成微信群适配器。

## 微信主 Runtime 的当前边界

新增微信 Source 只接受显式固定账号和 owner 的文本私聊，陌生人和群在产生工单前拒绝。绑定身份及凭证文件路径不能通过模型工具修改；已绑定 owner 不得复用原状态换人。凭证文件必须在宿主以私有权限保存，`context_token` 留在私有 KV，不进入 Trigger 和模型提示词。主 Runtime 状态和 DSH Session 仍含私聊内容。

[微信部署示例](examples/weixin.profile.cordis.patch.yml) 用空的 worker/router 工具插件清单，仅保留 SuperAgent 工单工具，便于验证文本任务。它不代表 OS 沙箱，也未改变上游默认预设的 `danger-full-access`。其他插件或后续 shell 工具仍需单独限制。GitHub 明确禁用时不加载其账号，CLI shim 拒绝回退到操作者账号。

发送超时或断线可能已经送达手机；本地分段状态阻止自动重发不确定请求，需人工核实。凭证文件的轮询租约只覆盖同一主机、同一路径，部署迁移前须停掉其他轮询进程。成员模式每个成员有私有路由；旧单 owner 数据不能原地切入成员模式继承共享历史，需新状态目录。停用成员会阻止后续输入、工具调用、排队执行与分段投递；停用前已在外部送达的内容不能撤回。
