# 开发与构建

## 源码运行

当前主要支持 macOS + Codex 桌面应用，手机使用 Android 8+ 或浏览器。Python 3.10+ 运行服务，二维码为可选依赖。

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python monitor.py
```

打开 `http://127.0.0.1:18377`。Mac 可直接双击根目录的 `启动副屏.command`，它优先使用项目 `.venv`。关闭其终端会停止对应服务。

参数可用 `python monitor.py --help` 查看：

- `--port`：默认 18377。
- `--host`：默认 0.0.0.0，手机连接需要监听局域网。
- `--codex-home`：默认 `$CODEX_HOME` 或 `~/.codex`；不会读取认证配置。
- `--runtime-dir`：独立配对及去重数据目录，默认源码 `.runtime/`。
- `COMPANION_DATA_DIR`：数据目录的环境变量，命令行参数优先。

账号和 API / 中转 Token 配置由电脑 Codex 负责。本项目没有模型接口设置，不测试或保证任意第三方中转服务可用。

## 测试

```bash
python3 -m unittest discover -s tests -v
npm ci
npx playwright install chromium
# 另一个终端先启动 monitor.py
npm test
```

`npm test` 使用模拟数据，不要求真实 Codex 账号或活动会话。`npm run test:live` 另外测试本机实际桌面订阅、配对与二维码，要求有活动的本机 Codex 会话和可用二维码依赖。CI 只运行隔离测试，不访问开发者账号。

可用 `COMPANION_TEST_URL` 改测试服务地址，`COMPANION_CHROME_PATH` 指向本机 Chrome 可执行文件；默认使用 Playwright 下载的 Chromium。

## 构建 Android

需要 JDK 17、Android Platform 35、Build Tools 35.x，可通过 Android Studio 的 SDK Manager 安装。设置：

```bash
export COMPANION_JAVA_HOME="$JAVA_HOME"
export COMPANION_ANDROID_BUILD_TOOLS="$ANDROID_HOME/build-tools/35.0.0"
export COMPANION_ANDROID_JAR="$ANDROID_HOME/platforms/android-35/android.jar"
python3 scripts/build_apk.py
```

版本来自 `VERSION`，须与 `AndroidManifest.xml` 的 versionName 保持一致；升级时递增 versionCode。首次构建自动生成 `android/signing/`，仅用于你的构建。**自己的签名不能覆盖安装他人签名的 APK**；长期发布必须离线备份相同签名，不将其上传仓库。脚本同时验证签名、zip 对齐和地址信任边界。

## 构建 Mac 独立包

在目标架构的 macOS 13+ 上安装 Xcode Command Line Tools，准备上一步 APK，然后：

```bash
python3.12 -m venv .venv-build
.venv-build/bin/pip install -r requirements-build.txt
.venv-build/bin/python scripts/build_desktop.py
```

结果在 `release/`。推荐使用支持 macOS 13 的 Python 3.12 运行时构建，并检查每个原生依赖的最低系统版本；仅设置启动器的 target 不会降低内置 Python 的要求。该包带 Python、二维码运行时和 APK，普通用户不需安装 Python、Node 或 JDK。Apple 芯片和 Intel 需分别在相应环境构建。当前只做本地 ad-hoc 签名，没有 Developer ID 签名和公证；这不是已验证的跨架构通用包。

Mac 菜单栏原生启动器在 `desktop/Launcher.swift`，启动后打开本机浏览器；后台执行文件由 PyInstaller 构建。App 数据目录为 `~/Library/Application Support/Codex Companion/`，不会写入签名的 `.app` 内部。退出只停止自身创建的进程，不结束已有源码服务。

## 导出开源包

```bash
python3 scripts/package_release.py
```

脚本按文件与目录白名单导出源码；排除工作数据、截图输出、签名、工具链、依赖、缓存和 Git 元数据，生成源文件清单与 SHA-256。不要把整个工作目录直接压缩上传。Android APK 和 Mac 下载包放 Releases，源码目录用于 Git 仓库。

`npm run screenshots` 用固定虚构数据生成 `docs/images/` 展示图，不包含真实进度、配对码或二维码。详情、信任边界和协议说明见 [架构说明](ARCHITECTURE.md)。
