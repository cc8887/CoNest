# CoNest Docker 验证版

面向 N100 的 `linux/amd64`，当前仅允许一位绑定 owner 的文本私聊。镜像包含 Node 24.22.3、固定 DSH 0.2.1-alpha.2 和已构建的 CoNest；宿主不必升级 Node 或 pnpm。镜像没有模型密钥、微信凭证或私聊数据。不要并行轮询同一 bot。

Release 提供镜像归档、源码包、`compose.yml`、模型环境模板及 `SHA256SUMS`。本仓库为私有仓库，下载需登录有权限的 GitHub 账号。下载同一个版本的全部附件到独立目录，先运行：

```bash
sha256sum --check SHA256SUMS
docker load --input conest-0.1.0-m0.1-linux-amd64.docker.tar.gz
mkdir -p secrets
cp model-test.env.example secrets/model-test.env
chmod 700 secrets
chmod 600 secrets/model-test.env
```

在本机编辑 `secrets/model-test.env`，填写已有测试模型 API key。它不会进入镜像，但 Compose 会把它交给宿主容器进程；能管理 Docker 的管理员也能访问容器环境。密钥和 PIN 不要贴到聊天里。

先验证镜像与模型：

```bash
docker compose run --rm conest m0 doctor
docker compose run --rm conest m0 model
```

接着在终端启动绑定，打开其输出的 `http://127.0.0.1:3087/<随机路径>/` 网页扫码。需要 PIN 时只在该网页输入：

```bash
docker compose run --rm --service-ports conest m0 login
```

绑定成功后初始化一个新 Runtime 并启动：

```bash
docker compose run --rm conest init
docker compose up -d
docker compose logs -f conest
```

`init` 从同一数据卷中的 M0 绑定导出一个账号，创建原有 `orchestrator.sqlite`，默认禁用 GitHub/飞书并配置单 worker。已有数据库时拒绝覆盖，重启只需 `docker compose up -d`。多个 M0 绑定需用 `init --account <bot-id>` 明确选择。迁移已有账号可在卷中放置私有 `weixin-account.json`，需匹配 UID 1000 和 0600 权限；不要复制他人的状态或复用旧主 Session 换 owner。

服务日志会输出带访问凭据的管理地址，按私有信息保管。日志中的管理地址若使用 `0.0.0.0:3088`，浏览器访问时只将主机名换成 `127.0.0.1:3088`，保留原 token。容器内部监听 `0.0.0.0` 以支持端口映射；Compose 只发布宿主 `127.0.0.1:3087/3088`，不要改成公网或局域网监听。扫码网页仍校验随机路径、Host 和 PIN POST 的同源条件。主 Runtime 面板继续校验认证与同源请求。

数据都在 `conest-data` 卷：`m0/` 绑定与连接日志、`weixin-account.json`、`runtime/` 工单与投递状态、`dsh/` profile 与 Session、`home/` 宿主缓存。镜像升级不应删除该卷。`docker compose down` 停止服务并保留数据；`down -v` 会删除数据，不作为普通停止或升级命令。

Compose 使用非 root UID 1000、只读根文件系统、临时 `/tmp`、不挂载宿主目录或 Docker socket，默认限制 2 个 CPU 和 2 GB 内存。它是初始部署配置，尚非 N100 容量实测或成员隔离验收。现有 worker/router 只开放工单工具；上游 DSH 权限预设仍为 `danger-full-access`，镜像中保留 M0 所需依赖及构建依赖，未宣称最小生产镜像。

如果在 N100 使用已有 Podman，可先用 `podman load --input ...` 导入同一归档；Compose 的具体实现与网络需现场核实，本版 CI 使用 Docker 验证。不要为了导入镜像同时启动第二个服务实例。

本地构建及发布：

```bash
docker build --platform linux/amd64 --build-arg VERSION=0.1.0-m0.1 -t conest:0.1.0-m0.1 .
bash scripts/docker-smoke.sh conest:0.1.0-m0.1
```

Docker 构建阶段执行完整 `pnpm check`；发布工作流随后核对架构、非 root 用户、M0 doctor、无真实渠道流量的主 Runtime 启动与容器重启。全部成功后，才上传并公布 GitHub 预发布附件。真实微信收件在开发机已验证，Docker/N100 上仍需按[主 Runtime 验收](https://github.com/cc8887/CoNest/blob/main/docs/conest/weixin-runtime.md)单独确认。
