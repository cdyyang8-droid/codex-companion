# GitHub 发布流程

公开仓库：[cdyyang8-droid/codex-companion](https://github.com/cdyyang8-droid/codex-companion)。`release/` 下载包不进入源码提交，上传到 GitHub Releases。

## 发布流程

1. 核对仓库归属与当前分支；新建仓库时先不要自动生成 README 或许可证。
2. 检查源码导出目录，不含 `.runtime/`、`.android-tools/`、`android/signing/`、`dist/`、`outputs/`。
3. 首次发布在项目目录初始化 Git 并设置 main，仅添加审核过的源码；后续正常提交和推送，保留已有历史。
4. 在仓库 Settings → Security 开启 Private vulnerability reporting；确认 CI Checks 通过。
5. 在检查通过的提交上创建版本 tag 和 Release，附件放 APK、Mac ZIP、手工源码 ZIP 和 `SHA256SUMS.txt`，说明使用环境和未公证限制。首版 `v1.3.0` 标为预发布。
6. README 使用相对链接，可在仓库创建后直接打开 Releases。设置 About 描述和 Topics：`codex`、`android`、`lan`、`companion`。

## 推荐简介

> 用 Android 手机做 Codex 的局域网副屏：实时进度、手动审批、文字回复和常亮。副屏无需登录账号，沿用电脑端已配置的 API / 中转 Token 会话。

## 发布说明草稿

Codex Companion 1.3.0：把 Codex 进度放到手机上。面向同一局域网，不要求副屏账号或额外 API Key。支持任务状态、执行计时、审批与回复、Markdown、六位码配对、Android 常亮，以及 Mac 双击启动器。

Mac ZIP 适用于 Apple 芯片 / macOS 13+，Android APK 适用于 Android 8+。本项目使用桌面内部协议，兼容性随 Codex 版本变化；无公网接入和锁屏推送。Mac App 尚无 Developer ID 签名和公证，首次打开请按系统可信来源提示处理。

## 后续版本

保留 Android 发布签名，更新 `VERSION`、package.json、网页版本、Android versionName/versionCode 及 CHANGELOG。重新测试、构建并执行 `scripts/package_release.py`；不要更换已发版标签内容。源码分支不保存签名、设备记录或二进制下载包。
