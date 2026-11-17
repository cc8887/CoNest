# CoNest 共栖

研究与开发中的初始化。这不是已经能用的家庭助手，也不是 DeepSeek 或腾讯的官方产品。

CoNest（共栖）打算做成面向家庭和小组、可自托管的助手：以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的研究原型 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) 为唯一的工单、Attention 与报告状态机，旁边放一个尚未接入运行时的家庭领域模块，渠道则继续走原型的 Source。本仓库是该原型的小型分叉，加上这些骨架。

English: CoNest is a private research fork of the DSH SuperAgent prototype plus a separate family-domain skeleton that is not wired into the agent. It is not an official DeepSeek or Tencent product, and scaffolding in this repository is not a working multi-member assistant.

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
- [上游来源与更新方式](docs/conest/provenance.md)：精确的上游地址、提交和工具链版本
- [安全说明](SECURITY.md)：继承的执行权限，以及为什么现在不能当多用户系统
- 上游安装与行为文档仍从 [SETUP.md](SETUP.md) 和 [000 Philosophy](docs/000-philosophy.md) 读起。`SETUP.md` 会引导操作者创建真实账号并写入本机凭证。本次初始化没有执行它，也没有连接任何消息账号。

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

自托管的目标机器是 Intel N100，内存和操作系统还没有测定，因此这里不做性能或容量声明，也不调并发参数。

## 许可

上游代码与本仓库的 [LICENSE](LICENSE) 保持 MIT，版权声明仍是 DeepSeek Harness Team（2026）。CoNest 新增文件使用同一许可证，不替换该声明。
