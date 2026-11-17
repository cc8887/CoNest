# 微信主 Runtime 部署与验证

日期：2026-11-17。当前范围是一个明确绑定 owner 的文本私聊，复用 SuperAgent 的 Store、Engine、Ticket、Assignment、Report、Attention、effects 和 outbox。可以禁用 GitHub 后运行。成员目录、跨成员授权和私有路由 Session 尚未接入，不能让十个人共用此配置作为隔离验收。

## 准备源码与私有状态

在开发机或 N100 的 Ubuntu WSL2 内使用符合 `package.json` 的 Node.js 与 pnpm `11.7.0`。源码和状态放在 Linux 文件系统；不要从开发机复制 `node_modules` 或原生编译产物。

N100 已报告 Node 18 与 pnpm 10，需先按 [N100 现场步骤](n100-wsl.md)安装私有工具链，再执行下面的构建流程。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm m0 doctor
```

先停止所有针对同一 bot 的 M0 / 主 Runtime 轮询进程。首次绑定运行 `pnpm m0 login`，在临时回环网页扫码，需要 PIN 时直接填网页。已有绑定可复用，无需重复扫码。导出恰好一个账号：

```sh
mkdir -p ~/.config/conest
chmod 700 ~/.config/conest
pnpm m0 export-account --output "$HOME/.config/conest/weixin-account.json"
```

多个绑定时加 `--account <bot-id>`。导出拒绝覆盖已有文件，输出文件权限为 `0600`。不要打印、提交或发到聊天中。模型凭证沿用仓库外的 `~/.config/conest/model-test.env`，内容变量见 [M0 文档](m0.md)，权限同样为 `0600`。

为新 Runtime 初始化原有 Store：

```sh
pnpm weixin:setup \
  --state-dir "$HOME/.local/state/conest/runtime-weixin" \
  --credentials-file "$HOME/.config/conest/weixin-account.json" \
  --provider conest --model hy4
```

该命令只接受新数据库，拒绝覆盖已有 `orchestrator.sqlite`。它固定账号和 owner、设置允许名单、禁用 GitHub/飞书，并配置 hy4、1 个 worker 与 600 秒评估超时。不导入 M0 的私聊 Session 或任务日志。重新启动直接使用现有状态，不要再初始化。换账号或 owner 必须使用新状态目录及新 DSH profile，避免继承旧主 Session。

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

`DSH_HOME` 和 `PATH` 需在当前终端生效；新终端重新设置。DSH 启动输出的管理地址含本机访问凭据，按私有信息保存。面板仅监听 `127.0.0.1:3088`。检查 Runtime 与微信健康为 ready、GitHub setup 无错误，再向已绑定机器人发送：

```text
请创建工单，生成三条测试清单：身份校验、任务执行、结果回传。完成后通过工单报告，把清单发回微信。
```

验收需同时核对：原私聊已入站、模型调用 `orchestrator_route` 建单、独立 worker 调用 `orchestrator_report`、主 Session 调用 `orchestrator_reply`、outbox 标记发送，以及手机实际收到。worker 的报告先进入主 Session，不会绕过主 Session 直接发微信。停止使用 `Ctrl+C`，等待轮询取消和 Store 关闭后再迁移或启动其他实例。

## 恢复与边界

- Trigger 与游标在原 Store 同一事务提交，重复轮询不重复创建 Trigger；回复 context 只在宿主私有 KV 中保存。
- 私聊跟进沿原 Ticket 的订阅进入 worker；Attention 与结果使用原 outbox 回到原绑定私聊。群、陌生人、多媒体和缺少回复上下文的消息不产生任务。
- 发送分段有稳定客户端 id。本地 `sending` / `uncertain` 状态阻止盲目重发；网络错误不等于手机未收到。先核实手机，再由操作者处理投递记录，当前没有自动修复不确定回执的命令。
- 凭证文件轮询锁是同主机同路径的租约；无法阻止另一台机器或复制凭证后的另一路径轮询。迁移前明确停止旧实例。
- 模型输出额度耗尽、供应商错误或评估超时可在 Session 和管理面板查看；修复配置后重启，再重新评估原 Trigger。不要删除已有数据库来掩盖失败。
- 该示例没有改变上游 `danger-full-access` 权限预设，也没有提供 OS 沙箱。多成员部署必须先实现范围隔离、工具授权和成员存储，详见[开发方案](development-plan.md)。

## 验证记录

离线 `pnpm check`：1251 项测试通过，类型检查与构建通过。主 Runtime 集成测试覆盖无 GitHub 启动、真实 Engine 建单、追问/续接/完成、原私聊 outbox、去重、游标事务回滚、旧消息重放和绑定修改保护。

开发机真实 DSH/hy4 主 Runtime 已在 GitHub 禁用时完成：用户微信入站 → 模型调用 orchestrator_route → 一个真实 Ticket → 独立 worker 调用 orchestrator_report ready → 工单 completed → 主 Session 调用 orchestrator_reply → 接单与结果 outbox 均 sent、effects 清空。用户确认手机收到完整的三项清单，测试进程已停止。初次 4096 token 额度失败及后续重新评估的记录保留在私有 DSH Session，没有删除失败来替代验收。该次链路有数分钟模型推理延迟，只证明功能闭环；响应时间与模型费用仍需优化。M0 证据另行保留。

新构建的开发机 Runtime 重启检查也通过：无 GitHub 启动正常，已完成工单和 sent 回执保留，effects 为空，检查进程已停止。这不是 Windows/WSL 或整机重启验收。

N100 已确认 Windows 11 专业版 `10.0.26200.9974`、15.8 GB 内存、WSL `2.7.14.0`、Ubuntu WSL2/x86_64。当前 Node `18.19.1` 与 pnpm `10.2.1` 需先升级私有工具链。真机运行、常驻与重启恢复、100 个未完成任务的容量尚未实测。用户暂无第二个微信账号，真实双账号验收暂缓。
