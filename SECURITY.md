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

本次初始化没有创建 GitHub 账号、飞书或 Lark 应用、微信账号，也没有写入任何密钥。

不要提交：

- DSH 配置文件目录（默认 `~/.dsh`，可用 `DSH_HOME` 改到别处）及其 `stateDir`
- `<stateDir>/orchestrator.sqlite`、`worker-bin/`、`worker-gitconfig/`
- `gh` 的 `GH_CONFIG_DIR`、飞书或 Lark 的 `LARKSUITE_CLI_CONFIG_DIR`，以及其中的应用密钥
- `.env` 和任何真实令牌

`.gitignore` 排除了常见的 SQLite、`.dsh/`、包装脚本目录和密钥文件名。状态目录仍应放在仓库之外；忽略规则不是加密。

[`.env.example`](.env.example) 只列出占位变量名。原型不读取该文件。DeepSeek Harness 的模型供应商配置在它自己的配置文件里，不在这个示例中放密钥。

## 渠道

已随上游导入的渠道是 GitHub，以及默认关闭的飞书 Source。微信、WeChat Claw、iLink 的群能力没有核实，也没有实现。不要把飞书 Source 当成微信群适配器。
