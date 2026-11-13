import AppKit
import Foundation

func serviceJSON(_ url: URL) -> [String: Any]? {
    var request = URLRequest(url: url)
    request.timeoutInterval = 0.4
    let ready = DispatchSemaphore(value: 0)
    var result: [String: Any]?
    let task = URLSession.shared.dataTask(with: request) { data, response, _ in
        if let response = response as? HTTPURLResponse, response.statusCode == 200,
           let data = data {
            result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        ready.signal()
    }
    task.resume()
    guard ready.wait(timeout: .now() + 0.6) == .success else { task.cancel(); return nil }
    return result
}

func companionServiceAvailable(at home: URL) -> Bool {
    guard let result = serviceJSON(home.appendingPathComponent("api/health")), result["ok"] as? Bool == true else { return false }
    if result["app"] as? String == "codex-companion" { return true }
    // Older versions returned only {ok:true}; identify them before reusing.
    guard result["app"] == nil else { return false }
    return serviceJSON(home.appendingPathComponent("api/discovery"))?["app"] as? String == "codex-companion"
}

final class CompanionApp: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var backend: Process?
    private var logHandle: FileHandle?
    private let home = URL(string: "http://127.0.0.1:18377/")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "⌁ 副屏"
        let menu = NSMenu()
        for (title, action) in [("打开副屏", #selector(openDashboard)), ("连接手机 / 查看配对码", #selector(openPairing)), ("下载 Android 安装包", #selector(openDownload)), ("打开数据文件夹", #selector(openData))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "退出副屏", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
        DispatchQueue.global(qos: .userInitiated).async {
            let existing = self.healthy()
            DispatchQueue.main.async {
                if existing { self.openPairing() } else { self.launchBackend() }
            }
        }
    }

    private func healthy() -> Bool {
        companionServiceAvailable(at: home)
    }

    private func dataDirectory() -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Codex Companion")
    }

    private func launchBackend() {
        guard let resources = Bundle.main.resourceURL else { showError("应用资源缺失，请重新解压下载包。"); return }
        let executable = resources.appendingPathComponent("backend/companion-server/companion-server")
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--runtime-dir", dataDirectory().path]
        do {
            try FileManager.default.createDirectory(at: dataDirectory(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let log = dataDirectory().appendingPathComponent("server.log")
            if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            logHandle = try FileHandle(forWritingTo: log)
            logHandle?.seekToEndOfFile()
            process.standardOutput = logHandle
            process.standardError = logHandle
            try process.run()
            backend = process
        } catch { showError("无法启动本地服务：\(error.localizedDescription)"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<40 {
                if self.healthy() {
                    DispatchQueue.main.async { self.openPairing() }
                    return
                }
                if !process.isRunning { break }
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async { self.showError("本地服务未能启动。请检查 18377 端口是否已被其他程序占用；详细信息见数据文件夹中的 server.log。") }
        }
    }

    private func showError(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Codex 副屏暂时无法启动"
        alert.informativeText = message
        alert.addButton(withTitle: "知道了")
        alert.runModal()
    }
    @objc func openDashboard() { NSWorkspace.shared.open(home) }
    @objc func openPairing() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:18377/#connect")!) }
    @objc func openDownload() { NSWorkspace.shared.open(home.appendingPathComponent("download.apk")) }
    @objc func openData() { NSWorkspace.shared.open(dataDirectory()) }
    @objc func quitApp() { NSApp.terminate(nil) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { openDashboard(); return false }
    func applicationWillTerminate(_ notification: Notification) {
        // Only stop the process this app started; an existing source service is
        // shared and must remain running when this launcher exits.
        if let process = backend, process.isRunning { process.terminate(); process.waitUntilExit() }
        try? logHandle?.close()
    }
}

// A bounded, headless diagnostic for installation checks.
if CommandLine.arguments.contains("--check-service") {
    let available = companionServiceAvailable(at: URL(string: "http://127.0.0.1:18377/")!)
    print(available ? "Codex Companion service available" : "Codex Companion service unavailable")
    exit(available ? 0 : 1)
}

let application = NSApplication.shared
let delegate = CompanionApp()
application.delegate = delegate
application.run()
