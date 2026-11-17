# CoNest 共栖

开发中。已提供微信单账号私聊 Source 和 M0 连接验证入口；家庭助手仍在开发，也不是 DeepSeek 或腾讯的官方产品。

CoNest（共栖）打算做成面向家庭和小组、可自托管的助手：以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的研究原型 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) 为唯一的工单、Attention 与报告状态机，渠道沿用 Source 接口，新增绑定本人私聊的微信适配器。家庭领域模块尚未接入运行时。

English: CoNest is a private research fork of the DSH SuperAgent prototype with a single-owner Weixin Source and a standalone M0 connectivity probe. The family-domain skeleton is not wired into the agent. It is not an official DeepSeek or Tencent product or a working multi-member assistant.

## 现在能说明什么

上游原型按它自己的文档可以继续开发、测试和构建。本仓库保留它的包名 `dsh-superagent`、插件 id 和 `cordis.patch.yml`，避免改名破坏 DeepSeek Harness 的加载。继承下来的能力以原型代码和 `docs/` 为准，包括：

- GitHub Source，以及可选的飞书（Feishu / Lark）Source
- 按 Source 身份执行的策略门闩、Mandate 与工单（Ticket）
- Assignment、Report、Attention（问题回到触发它的那条对话，或工单开始的对话）
- 每个工单一个执行器 Session 和目录，以及可配置的 `prepare` 命令
- 管理面板，以及 `<stateDir>/orchestrator.sqlite` 里的原型状态

这些是上游原型的行为，不是 CoNest 已经实现的家庭隔离。

## 还没有实现，不能当成已经具备

下列能力只出现在设计里。[家庭领域骨架](src/family/index.ts) 里的类型和 `authorize` 没有被插件调用。测试只证明这个纯函数的判断，不证明运行中的 Session 会拒绝越权。

- 多个家庭成员各自的私聊，以及成员之间的群协作
- 把渠道账号稳定绑定到成员，并在运行时执行这套绑定
- 默认私有的记忆，以及必须显式记录的家庭共享
- 工单的可见性、所有者与参与者
- 把问题发给被授权的那一位成员，并和具体工单、Attention 对齐，重启后仍然投递
- 后台任务，以及带预算上限的长期目标
- 微信、WeChat Claw、iLink 的群。官方群能力尚未核实，这里不实现，也不承诺

提示词不能代替隔离。上游已经要求宿主执行允许名单、规则和 Mandate；跨 Source 的“这是同一个人”在原型里只是提示词。CoNest 不能靠提示词把家庭成员隔开。

## 文档

- [架构决定](docs/conest/architecture.md)：仓库边界、提议中的内核扩展点、Source 下一步接缝
- [多用户开发方案](docs/conest/development-plan.md)：Windows 与 WSL 部署、微信优先、约 10 人与 100 个未完成任务的设计，以及成员隔离、hy4 和分阶段验收
- [M0 运行与验证](docs/conest/m0.md)：微信扫码与 PIN、本机私聊验证、真实 DSH 工具调用、配置与恢复
- [微信主 Runtime 部署](docs/conest/weixin-runtime.md)：微信进入真实工单、hy4 配置、单账号部署与恢复
- [N100 / WSL2 现场步骤](docs/conest/n100-wsl.md)：已确认的设备信息、私有工具链安装与构建检查
- [Docker 部署](docs/conest/docker.md)：linux/amd64 镜像、数据卷、扫码绑定与主 Runtime 启动
- [上游来源与更新方式](docs/conest/provenance.md)：精确的上游地址、提交和工具链版本
- [安全说明](SECURITY.md)：继承的执行权限，以及为什么现在不能当多用户系统
- 上游安装与行为文档仍从 [SETUP.md](SETUP.md) 和 [000 Philosophy](docs/000-philosophy.md) 读起。`SETUP.md` 会引导操作者创建真实账号并写入本机凭证。最初初始化未执行该流程；后续微信现场测试已由用户扫码授权。

编号文档 [001](docs/001-domain.md) 到 [008](docs/008-cookbook.md) 是上游原型的领域说明，没有改写成 CoNest 的产品承诺。

## 开发

需要 Node.js `^22.19.0 || >=24`（见 `package.json` 的 `engines`）和 pnpm `11.7.0`。

```sh
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

`pnpm check` 依次做类型检查、测试和构建。测试不需要模型 API 密钥。家庭授权测试在 `tests/family-authorization.spec.ts`，随 `pnpm test` 一起跑。

微信主链路已接入原有 Store、Engine、Ticket、Attention 和 outbox；`sources.github.enabled: false` 的部署可不配置 GitHub 账号。新增命令 `pnpm weixin:setup` 为一个绑定用户初始化独立状态，默认 1 个 worker。步骤见[微信主 Runtime 文档](docs/conest/weixin-runtime.md)。

M0 仍保留 `pnpm m0 model/login/weixin` 供排查连接。M0 已完成真实 DSH/hy4 工具往返及手机收件确认；它自身不创建工单。消息接入抛错桩已被真实映射替换，当前全量检查为 1251 项测试通过，类型检查与构建通过。

自托管的目标机器是 Intel N100，已确认 Windows 11 专业版、15.8 GB 内存、WSL 2.7.14.0 与 Ubuntu WSL2/x86_64。产品面向约 10 人的小家庭或小团队，优先微信机器人，使用云端推理；目标是最多约 100 个未完成任务，允许排队。方案以 WSL2 内运行、单 worker 起步。尚无真机容量测量，微信 Source 当前仅接受一位绑定 owner 的文本私聊，多成员隔离尚未实现。

## 许可

上游代码与本仓库的 [LICENSE](LICENSE) 保持 MIT，版权声明仍是 DeepSeek Harness Team（2026）。CoNest 新增文件使用同一许可证，不替换该声明。
