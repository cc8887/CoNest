# N100 / Ubuntu WSL2 现场部署

2026-11-17，用户提供的设备信息：

| 项目 | 当前值 |
| --- | --- |
| 系统 | Windows 11 专业版，`10.0.26200.9974` |
| 物理内存 | 系统报告 `15.8 GB` |
| WSL | `2.7.14.0`，内核 `6.18.33.2-2` |
| 发行版 | Ubuntu，WSL2，`x86_64` |
| Node | `18.19.1`，低于项目要求 |
| pnpm | `10.2.1`，与项目固定版本不同 |
| Git | `2.43.0` |

先使用一个 worker 做功能验收。上述设备信息不代表已经通过 100 个未完成工单的容量测试；也尚未验证 Windows 重启或休眠后的常驻恢复。本次不修改 `.wslconfig`，不启动 Docker 或停止 Podman。

用户随后要求优先发布 Docker 镜像。使用 [Docker 部署](docker.md)时，镜像自带 Node 与 DSH，宿主 Node 18 / pnpm 10 可保留；下述源码工具链安装是另一个部署选择。已有 Podman 的导入与网络仍需现场确认。

## 复制源码与安装工具链

使用最新的 `conest-weixin-source.tar.gz` 和配套 `.sha256` 文件。源码包不包含密钥、私聊、DSH Session 或编译产物。将两个文件复制到 N100 的 `C:\Users\Desktop\Downloads`，文件名保持不变。

在 N100 PowerShell 进入 Ubuntu：

```powershell
wsl -d Ubuntu
```

随后在 Ubuntu 终端粘贴下面整段。它在独立 shell 中遇错即停；使用新源码目录，不覆盖已有项目：

```bash
bash -e <<'BASH'
cd /mnt/c/Users/Desktop/Downloads
sha256sum --check conest-weixin-source.tar.gz.sha256
mkdir -p "$HOME/src"
mkdir "$HOME/src/conest-n100-20261117"
tar -xzf conest-weixin-source.tar.gz -C "$HOME/src/conest-n100-20261117"
cd "$HOME/src/conest-n100-20261117"
bash scripts/setup-n100-toolchain.sh
source "$HOME/.config/conest/toolchain.env"
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm m0 doctor
BASH
```

如果该源码目录已存在，命令会停下。确认之前解压已成功后，可进入该目录从工具链安装步骤继续；不要直接删除或覆盖有状态的目录。下载或构建失败时保留最后一段错误。脚本若报告缺少 curl，可在 Ubuntu 单独运行 `sudo apt-get update` 与 `sudo apt-get install ca-certificates curl`，密码直接输入本机终端。

[`scripts/setup-n100-toolchain.sh`](../../scripts/setup-n100-toolchain.sh) 将 Node `24.22.3` 和 pnpm `11.7.0` 安装在 `~/.local/share/conest/toolchains`。Node 版本选自[官方 LTS 下载列表](https://nodejs.org/en/download)，Linux x64 归档使用[官方 SHA256 清单](https://nodejs.org/dist/v24.22.3/SHASUMS256.txt)的固定摘要校验后再解压；pnpm 使用[官方文档支持的 npm 安装方式](https://pnpm.io/installation)并固定版本与私有 prefix。没有改动系统 Node、已有 pnpm、shell 启动文件或模型凭证。脚本校验平台、版本与并发安装锁；再次运行会复用已安装的指定版本。

新 Ubuntu 终端中，在运行任何 CoNest / DSH 命令前执行：

```bash
source "$HOME/.config/conest/toolchain.env"
cd "$HOME/src/conest-n100-20261117"
```

回传 Node/pnpm 的版本、`pnpm check` 结论和 `pnpm m0 doctor` 输出。`doctor` 报告的是 WSL 可见内存，不应把它替代上面的 Windows 物理内存记录。此步骤不使用模型密钥，也不绑定或轮询微信。

## 构建通过后的步骤

1. 在 Ubuntu 的仓库外受限目录配置模型凭证，先完成 `pnpm m0 model` 的真实 DSH/hy4 工具验证。不要把密钥贴到聊天里。
2. 开发机测试进程已经停止。确认同一 bot 没有其他轮询者后，在 N100 使用扫码绑定或安全迁移已有凭证；需要 PIN 时直接在本机绑定网页输入。
3. 按[微信主 Runtime 文档](weixin-runtime.md)初始化新状态、安装固定 DSH、启用单 owner 微信 Source，完成真实工单与手机收件验收。
4. 记录进程与 WSL 内存、模型耗时和断线恢复。功能通过后再配置常驻与 Windows 生命周期，不提前把验证进程设成开机服务。

开发机在 Node 24.22.3 上的全量类型检查、1245 项原有测试和构建通过；后续新增 Docker 检查后全量测试为 1251 项。安装脚本已完成语法、平台拒绝和官方 Linux 归档下载校验检查；N100 的实际安装和运行结果以用户回传为准。
