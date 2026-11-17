# CoNest Docker 验证版

`v0.2.0-alpha.1` 面向 N100 的 `linux/amd64`，提供每位成员独立租户的网页注册、微信扫码绑定、个人任务页面与共享工单队列。镜像包含 Node 24.22.3、固定 DSH 0.2.1-alpha.2 和已构建的 CoNest；宿主无需安装 Node 或 pnpm。它是预发布版，N100 真机与多个真实微信账号仍待现场验收。旧 `v0.1.0-m0.1` 只支持一位 owner。

## 下载与启动

本仓库为私有仓库，下载需要有权限的 GitHub 账号。从同一 Release 下载所有附件到独立目录：镜像归档、源码、Compose、模型模板、DOCKER.md、VALIDATION.json 和 SHA256SUMS。

```bash
sha256sum --check SHA256SUMS
docker load --input conest-0.2.0-alpha.1-linux-amd64.docker.tar.gz
mkdir -p secrets
cp model-test.env.example secrets/model-test.env
chmod 700 secrets
chmod 600 secrets/model-test.env
```

在本机编辑 `secrets/model-test.env`，填写已有 Tencent hy4 API key。模型供应商为 `https://copilot.tencent.com/v2/`，协议为 `openai-completions`，模型为 `hy4`。镜像不带真实凭证，PIN 和 key 不要贴到聊天中。Docker 管理员能访问容器环境，部署主机须可信。

DSH 管理服务要求回环监听，Compose 沿用 Linux `network_mode: host`，共享容器引擎宿主网络，不做桥接端口映射。Docker Desktop 需启用 host networking（4.34+）；Windows/WSL/Podman 到宿主的网络路径仍需现场验证。

```bash
docker compose run --rm conest m0 doctor
docker compose up -d
docker compose logs -f conest
```

首次启动自动创建空成员目录和原有 `orchestrator.sqlite`，默认禁用 GitHub/飞书，使用单 worker。无需先 `m0 login`、`init` 或导出成员凭证。日志中的管理地址含访问凭据，只交给平台管理员。需要单独排查真实模型连接时，可运行 `docker compose run --rm conest m0 model`；这会调用云模型。

## 创建成员与微信绑定

1. 管理员打开日志中的启动地址（默认 `http://127.0.0.1:3088/?token=...`），认证后直接进入 **CoNest 后台 → 成员与微信**。侧栏“高级控制台”保留 DSH 配置入口（`/index.html`），无需先经过 DSH 首页。
2. 填写成员名称，系统生成该成员的二维码和一次性个人访问链接。每位成员就是一个独立租户。
3. 对应成员用本人微信扫码并确认；需要 PIN 时直接填网页。也可先将个人链接交给成员，让其在自己的“微信连接”页完成。
4. 显示“微信已绑定”后，账号、允许名单和私有凭证已自动保存，无需改配置或重启。
5. 只将个人访问链接交给对应成员。链接一天内有效且仅能兑换一次；登录持续 30 天。登录后收藏不含 `#invite` 的个人地址。换浏览器或退出后，由管理员生成新链接；停用成员会撤销所有旧登录。

个人页面可提交任务、查看本人结果、回复追问、停止和重试；微信和网页共用同一成员身份与私有工单。账号仍只收扫码 owner 的文本私聊，不接陌生人或群。同一 bot/owner 不能改绑另一个成员。

## 手机或其他设备访问

默认个人服务为 `http://127.0.0.1:3089`，只能本机访问；默认链接不能直接在另一台手机打开。DSH 管理端继续仅在回环 `3088` 使用。

对外部署个人页面时，可用可信 HTTPS 反向代理只转发个人端口 `3089`，保留外部 Host。在数据卷 `/data/dsh/profiles/conest/cordis.patch.yml` 的 `dsh-superagent` 配置中添加 `portalOrigin: https://conest.example.com`（替换为自己的真实域名，不带路径或结尾斜线），然后重启并重新生成链接。代理不能转发 DSH 管理端口。

也可直接监听具体局域网 IP：设置 `portalHost`、`portalPort`、`portalTlsCertFile` 和 `portalTlsKeyFile`，TLS 文件使用容器内的私有数据卷或只读挂载路径。非回环监听必须启用 TLS；wildcard 监听被拒绝。证书需要被成员设备信任。该网络与证书配置仍需在 N100 现场完成。

## 数据与升级

数据保存在 `conest-data` 卷：`runtime/` 工单、网页凭据摘要、扫码状态、微信凭证和回执；`dsh/` profile 与 Session；`home/` 宿主缓存。默认个人目录不保存原始登录 token，扫码 PIN 不持久化。不要复制他人的状态来建立新租户。

已有成员模式升级前先停止旧实例并备份卷；导入新镜像后使用同一成员卷启动。旧单 owner（包括 M0.1）不能继承原共享 Session 转成成员模式，应保留旧卷，创建新的卷/Compose project，再从网页重新创建和绑定。不要让两个实例同时轮询同一账号。

```bash
docker compose down
docker compose up -d
```

`down` 保留数据；`down -v` 会删除卷，不是普通停止或升级命令。旧 `init`、`init-members` 和 M0 命令保留兼容，单 owner 路径见旧版 Release 的部署说明。

Compose 使用非 root UID 1000、只读根文件系统、noexec 临时目录、2 个 CPU 和 2 GB 内存，无宿主目录或 Docker socket 挂载。成员模式只开放受宿主检查的工单工具；底层 DSH 权限预设仍为 `danger-full-access`，不构成 OS 沙箱。2 GB 是初始配置，不是 N100 的容量保证。

## 本地构建与验收

```bash
docker build --platform linux/amd64 --build-arg VERSION=0.2.0-alpha.1 -t conest:0.2.0-alpha.1 .
bash scripts/docker-smoke.sh conest:0.2.0-alpha.1
```

构建执行完整 `pnpm check`。smoke 检查镜像架构、非 root、原生加载器、空目录网页注册启动、DSH 签名登录、个人界面、未授权拒绝和重启；随后在不允许外部网络的镜像里，用真实 DSH 与 mock 模型/iLink 跑 10 租户、100 工单和 210 次回传，报告见附件 VALIDATION.json。这不代替真实微信、hy4 性能或 N100 容量验收。

早先开发机原生 mock 有一次回执关联断言失败，后续 7 轮通过未确立根因。本版发布门槛包含上述 Linux 镜像验收，并增加失败诊断留存；此项继续跟进。
