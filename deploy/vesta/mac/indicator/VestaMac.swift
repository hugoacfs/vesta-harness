// Vesta Mac: a menu bar indicator and switch for vesta-mac (the door that lets the Vesta harness
// use this Mac). Green open lock = on, grey closed lock = off. Polls `vesta-mac status` every 5 s.
import AppKit

let home = FileManager.default.homeDirectoryForCurrentUser.path
let tool = home + "/.vesta-mac/vesta-mac"

func run(_ argument: String) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [tool, argument]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do { try process.run() } catch { return "error: \(error)" }
    process.waitUntilExit()
    return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
}

final class Indicator: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    let state = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
    let toggle = NSMenuItem(title: "Turn on", action: #selector(toggleTapped), keyEquivalent: "")
    var on = false
    var busy = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        toggle.target = self
        menu.addItem(state)
        menu.addItem(.separator())
        menu.addItem(toggle)
        menu.addItem(NSMenuItem(title: "Quit the indicator (leaves the door as it is)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
        refresh()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in self.refresh() }
    }

    func refresh() {
        DispatchQueue.global().async {
            let status = run("status")
            let sshd = status.contains("sshd on")
            let tunnel = status.contains("tunnel to vesta on")
            DispatchQueue.main.async { self.show(sshd: sshd, tunnel: tunnel) }
        }
    }

    func show(sshd: Bool, tunnel: Bool) {
        on = sshd && tunnel
        let half = (sshd || tunnel) && !on
        if let button = item.button {
            let symbol = on ? "lock.open.fill" : (half ? "lock.trianglebadge.exclamationmark.fill" : "lock.fill")
            let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Vesta Mac")
            image?.isTemplate = true
            button.image = image
            button.imagePosition = .imageLeading
            button.title = on ? " Vesta" : ""
            button.contentTintColor = on ? .systemGreen : (half ? .systemOrange : .secondaryLabelColor)
            button.toolTip = on ? "Vesta can use this Mac" : "Vesta cannot use this Mac"
        }
        state.title = on ? "Open: Vesta can use this Mac" : (half ? "Half open: sshd \(sshd ? "on" : "off"), tunnel \(tunnel ? "on" : "off")" : "Closed: Vesta cannot use this Mac")
        toggle.title = on ? "Turn off" : "Turn on"
        toggle.isEnabled = !busy
    }

    @objc func toggleTapped() {
        busy = true
        toggle.isEnabled = false
        let argument = on ? "off" : "on"
        DispatchQueue.global().async {
            _ = run(argument)
            DispatchQueue.main.async {
                self.busy = false
                self.refresh()
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let indicator = Indicator()
app.delegate = indicator
app.run()
