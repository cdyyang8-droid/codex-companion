# 第三方软件

本项目原创代码采用 [MIT License](LICENSE)。第三方组件保留各自许可证。

| 组件 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| [Marked](https://github.com/markedjs/marked) | 17.0.5 | 浏览器 Markdown 排版；随源码提供 | [MIT 与附带声明](public/vendor/marked-LICENSE.md) |
| [python-qrcode](https://github.com/lincolnloop/python-qrcode) | 8.2 | 可选 SVG 二维码；Mac 包内置 | BSD-3-Clause |
| [CPython](https://www.python.org/) | 3.12.13（当前 Mac 包） | Mac 包内置 Python 运行时 | PSF License 及其附带声明 |
| [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | 20260414（当前 Mac 包） | 可分发的 Python 及原生依赖 | [运行时与各组件声明](desktop/licenses/python-build-standalone/SOURCE.md) |
| [PyInstaller](https://pyinstaller.org/) | 6.17.0 | Mac 打包工具和引导程序 | GPL-2.0-or-later，含允许分发生成应用的 bootloader 例外 |
| [Playwright](https://playwright.dev/) | 1.58.2 | 仅开发测试使用 | Apache-2.0 |

Mac 发布包的 `licenses/` 收录 Python 运行时及原生依赖的上游声明、Marked、二维码库及引导程序的许可证。重新构建时应核对所选运行时的实际版本与依赖声明。Android 构建使用用户本机安装的 Android SDK 和 JDK，源码包不分发这些开发工具。

本项目是独立的社区工具，与 OpenAI 没有隶属关系，未获官方背书。Codex、Android、GitHub 等名称与商标归其各自所有者。
