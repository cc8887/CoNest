# 安全说明

CoNest 现在是 dsh-superagent 研究原型的分叉，加上一个没有接入运行时的家庭领域骨架。它不是可供家庭使用的多用户系统。不要把真实的家庭凭证、机器人密钥或模型密钥放进这个仓库。

## 继承的执行权限

上游部署文档写明，主 Session 与执行器 Session 都以操作者的操作系统用户身份运行，权限预设为 `danger-full-access`：

- `docs/006-deployment.md` 的 “Permissions and isolation”：两种预设都以 `danger-full-access` 作为操作者的 OS 用户运行，并读取已订阅线程中的消息。账号包装脚本默认选择智能体的凭证，并不隔离进程。执行器仍可按绝对路径执行程序，并读取操作者的主目录。上游给出的隔离办法是使用只含智能体凭证的专用 OS 账号。
- `src/app/sessions.ts` 在创建或恢复 Session 时调用 `permissionPresets.set(..., 'danger-full-access')`。
- `docs/003-execution.md`：执行器 Session 不经批准即执行命令。`worker-bin` 里的命令包装和目录只建立默认值，不是安全边界。

`cordis.patch.yml` 里的 `@deepseek-ai/dsh-bash-sandbox` 与 `@deepseek-ai/dsh-pwsh-sandbox` 把前台命令的等待时间限制为 5 秒（`timeoutMs` / `maxTimeoutMs`）。这是原型里的超时配置。本次初始化没有实现、也没有验证操作系统级或家庭成员级的 worker 沙箱。不要把这个插件名理解成 CoNest 已经隔离了执行器。

策略门闩（允许名单、准入表、Mandate）由宿主编译并执行，提示词不能改写这些权限。见 `docs/002-authorization.md` 与 `docs/004-prompts.md`。该门闩按每个 Source 自己的身份工作。它不认识 CoNest 的成员，也不会读取 `src/family`。

## 尚未提供的家庭隔离

`src/family/authorize.ts` 是默认拒绝的纯函数。`tests/family-authorization.spec.ts` 只检查这个函数。运行时没有调用它，`orchestrator.sqlite` 也不保存成员、绑定、记忆授权或 Attention 投递目标。

因此，下列说法目前都不成立：

- 成员之间已有私有记忆或私有工单
- 群聊已按成员名单隔离
- 提问会发给指定成员并在重启后仍投给该成员
- 提示词已经把家庭成员隔开

群成员名单还没有模型。授权函数对一切群会话直接拒绝，这只说明骨架拒绝假装群已可用。

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

发送超时或断线可能已经送达手机；本地分段状态阻止自动重发不确定请求，需人工核实。凭证文件的轮询租约只覆盖同一主机、同一路径，部署迁移前必须停掉其他轮询进程。当前不对多个成员共用主 Session 开放；这不是家庭或小团队隔离验收。
