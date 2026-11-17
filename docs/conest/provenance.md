# 上游来源与更新方式

CoNest 的可运行基线是 DeepSeek 公开的研究原型，不是重新手写的一份副本。

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/deepseek-ai/dsh-superagent-prototype |
| 默认分支 | `main` |
| 纳入的提交 | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` |
| 提交说明 | `feat: add the dsh-superagent research prototype` |
| 作者 | DeepSeek Harness Team \<team@dsh.dev\> |
| 提交时间 | 2026-10-31 20:05:39 +0800 |
| 许可证 | MIT，见仓库根目录 [LICENSE](../../LICENSE)，版权人 DeepSeek Harness Team，2026 |
| 导入方式 | 合并提交 `59d2462aaaeec9eaced039aa7a491efc853d6a38` |
| 导入时的父提交 | `806a1186042916f191c3fe6e32a86b6a65457c36`（本仓库仅含生成 README 的初始提交）与 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` |

上游当时只有这一个提交。本仓库的 `main` 与它没有共同祖先，因此导入使用 `git merge --allow-unrelated-histories`。合并之后，上述上游提交是本分支的祖先，之后的上游合并不需要再加这个参数。

导入合并的内容树与该上游提交一致。CoNest 的 README、家庭模块和文档在随后的提交里。

## 保持可合并

在本仓库克隆里：

```sh
git remote add upstream https://github.com/deepseek-ai/dsh-superagent-prototype.git
git fetch upstream
git merge upstream/main
```

冲突应在分支上解决，不要为了盖过上游而强推 `main`。不要把上游历史压扁后再当成新的根，否则下一次合并会失去共同祖先。

包名、插件名和导出路径保持上游原样：`package.json` 的 `name` 仍是 `dsh-superagent`，入口 `src/index.ts` 的 `name` 仍是 `dsh-superagent`，`cordis.patch.yml` 插入 `dsh-superagent`、`dsh-superagent/github-watch` 和 `dsh-superagent/feishu-watch`，面板打包 id 仍是 `dsh-superagent`。这些标识参与 DeepSeek Harness 加载。本次初始化不改它们。

## 锁定的工具链与 DSH 版本

以下数字摘自导入时的 `package.json` 与 `docs/006-deployment.md`，没有在本次初始化里改写。

| 来源 | 声明 |
| --- | --- |
| `packageManager` | `pnpm@11.7.0` |
| `engines.node` | `^22.19.0` or `>=24.0.0` |
| `engines.dsh` | `^0.2.1-alpha.2` |
| `devDependencies` 中的 `@deepseek-ai/dsh-*` | `0.2.1-alpha.2` |
| `@deepseek-ai/cordis` | `4.0.5-alpha.1` |
| `@deepseek-ai/schemastery` | `3.18.5-alpha.1` |
| `typescript` / `vitest` / `tsdown` | `6.0.3` / `4.1.8` / `0.22.14` |
| `docs/006-deployment.md` 的全局安装示例 | `npm install -g @deepseek-ai/dsh@0.2.1-rc.3` |

`engines.dsh` 与开发依赖是 `0.2.1-alpha.2`，部署文档里的全局安装示例是 `0.2.1-rc.3`。两处在上游原文中同时存在。本次初始化不把它们收成同一个版本，也没有安装全局 `dsh` 命令。

本仓库的持续集成只跑 `pnpm install --frozen-lockfile` 和 `pnpm check`，不调用模型 API，也不读取密钥。

## 相对上游的行为修改

家庭模块没有接入运行时。除 README、文档表、`.gitignore` 和持续集成外，上游逻辑只改了一处：`src/sources/feishu-loops.ts` 读取事件时，stderr 的 `[event] ready` 与 stdout 的事件行不在同一条管道上。在本环境的 Node.js 22.23.4 上，畸形 JSON 会先记成 `error`，随后才到达的 ready 又把健康状态写回 `ready`，于是 `tests/sources.spec.ts` 里“畸形行报错且不停止”稳定失败（当时 1203 通过、1 失败）。现在，本进程里已经报告过的解析错误不会被稍后的 ready 盖掉。这只为让导入的测试表达它原来的断言，不是家庭隔离，也没有新增渠道。
