# CoNest 共栖

开发中。已提供网页成员注册、微信扫码自动绑定、独立个人空间、私有路由 Session、工单权限隔离和共享队列；家庭共享等能力仍在开发，也不是 DeepSeek 或腾讯的官方产品。

CoNest（共栖）面向家庭和小组自托管：以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的研究原型 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) 为唯一的工单、Attention 与报告状态机，渠道沿用 Source 接口。宿主 `Members` 模块执行持久化身份绑定、成员私有 Session 和读写范围检查。

English: CoNest is a private research fork of DSH SuperAgent with pinned Weixin member identities, private routing sessions, host-enforced task access and one shared queue. Each member is a separate tenant with a personal web interface. Web enrollment of ten members and 100 tasks are verified locally with real DSH and mock channel/model I/O. It is not an official DeepSeek or Tencent product.

## 现在能说明什么

上游原型按它自己的文档可以继续开发、测试和构建。本仓库保留它的包名 `dsh-superagent`、插件 id 和 `cordis.patch.yml`，避免改名破坏 DeepSeek Harness 的加载。继承下来的能力以原型代码和 `docs/` 为准，包括：

- GitHub Source，以及可选的飞书（Feishu / Lark）Source
- 按 Source 身份执行的策略门闩、Mandate 与工单（Ticket）
- Assignment、Report、Attention（问题回到触发它的那条对话，或工单开始的对话）
- 每个工单一个执行器 Session 和目录，以及可配置的 `prepare` 命令
- 管理面板，以及 `<stateDir>/orchestrator.sqlite` 里的原型状态

这些是上游原型的行为，不是 CoNest 已经实现的家庭隔离。

## 还没有实现，不能当成已经具备

成员私有工单由运行时 `Members` 模块执行授权。[家庭领域骨架](src/family/index.ts) 中的共享记忆、参与者和群名单仍为设计，纯函数 `authorize` 没有被插件调用。尚未提供：

- 成员之间的群协作
- 默认私有的记忆，以及必须显式记录的家庭共享
- 私有工单的跨成员共享与参与者授权
- 后台任务，以及带预算上限的长期目标
- 微信、WeChat Claw、iLink 的群。官方群能力尚未核实，这里不实现，也不承诺

提示词不能代替隔离。上游已经要求宿主执行允许名单、规则和 Mandate；跨 Source 的“这是同一个人”在原型里只是提示词。CoNest 不能靠提示词把家庭成员隔开。

## 文档

- [架构决定](docs/conest/architecture.md)：仓库边界、提议中的内核扩展点、Source 下一步接缝
- [多用户开发方案](docs/conest/development-plan.md)：Windows 与 WSL 部署、微信优先、约 10 人与 100 个未完成任务的设计，以及成员隔离、hy4 和分阶段验收
- [M0 运行与验证](docs/conest/m0.md)：微信扫码与 PIN、本机私聊验证、真实 DSH 工具调用、配置与恢复
- [微信主 Runtime 部署](docs/conest/weixin-runtime.md)：微信进入真实工单、hy4 配置、网页注册、个人空间与恢复
- [N100 / WSL2 现场步骤](docs/conest/n100-wsl.md)：已确认的设备信息、私有工具链安装与构建检查
- [Docker 部署](docs/conest/docker.md)：linux/amd64 镜像、数据卷、扫码绑定与主 Runtime 启动
- [上游来源与更新方式](docs/conest/provenance.md)：精确的上游地址、提交和工具链版本
- [安全说明](SECURITY.md)：继承的执行权限，成员权限、网页入口与执行边界
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

微信主链路复用原有 Store、Engine、Ticket、Attention 和 outbox，可禁用 GitHub。`pnpm weixin:setup --web --state-dir /absolute/state` 初始化空成员目录，默认 1 个 worker。管理员打开启动地址后直接进入 **CoNest 后台 → 成员与微信** 创建成员；系统生成二维码，扫码确认后自动保存凭证、关联成员并加入允许名单。每位成员就是一个独立租户，通过管理员交付的一次性链接进入自己的网页，可提交任务、查看结果、回复追问、停止和重试。个人页面默认监听 `127.0.0.1:3089`，DSH 管理端保留在 `127.0.0.1:3088`。原单 owner / `--members-file` 初始化保留兼容。步骤见[微信主 Runtime 文档](docs/conest/weixin-runtime.md)。

M0 保留 `pnpm m0 model/login/weixin` 供排查连接，已完成真实 DSH/hy4 与手机收件确认；它自身不创建工单。`pnpm test:local-mock` 独立启动真实 DSH/Runtime，通过网页创建并模拟扫码绑定 10 个成员，验证 100 个工单、排队重启、私聊追问、越权拒绝及原账号回传，不需要真实凭证。`pnpm check` 覆盖全部回归、类型检查与构建。

目标机器是 Intel N100，已确认 Windows 11 专业版、15.8 GB 内存、WSL 2.7.14.0 与 Ubuntu WSL2/x86_64。面向约 10 人，云端推理，100 个未完成任务允许排队，单 worker 起步。成员各自绑定账号 owner；单机器人接收任意陌生人或微信群不在当前范围。N100 性能与多个真实微信绑定仍待现场验证。已发布的 [`v0.2.0-alpha.1`](https://github.com/cc8887/CoNest/releases/tag/v0.2.0-alpha.1) 包含默认 CoNest 后台、网页成员注册、个人空间和多成员共享队列，Linux 镜像已通过 10 租户/100 工单的 mock 验收；旧 `v0.1.0-m0.1` 仍是单 owner 版本。部署与升级按对应 Release 附件说明执行。

## 许可

上游代码与本仓库的 [LICENSE](LICENSE) 保持 MIT，版权声明仍是 DeepSeek Harness Team（2026）。CoNest 新增文件使用同一许可证，不替换该声明。
