@preconcurrency import AVFoundation
import AppKit
import CoreImage
import CoreMediaIO
import Darwin
import Foundation
import SwiftUI

var previewStatus: ((String) -> Void)?

func emit(_ fields: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: fields) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    if let event = fields["event"] as? String {
        DispatchQueue.main.async { previewStatus?(event) }
    }
}

func fail(_ code: String) -> Never {
    emit(["event": "error", "code": code])
    exit(1)
}

func enableDeviceScreens() {
    var property = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    var enabled: UInt32 = 1
    guard CMIOObjectSetPropertyData(
        CMIOObjectID(kCMIOObjectSystemObject), &property, 0, nil,
        UInt32(MemoryLayout<UInt32>.size), &enabled
    ) == noErr else { fail("SCREEN_DISCOVERY_FAILED") }
}

func screenDevices() -> [AVCaptureDevice] {
    if #available(macOS 14, *) {
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external], mediaType: .muxed, position: .unspecified
        ).devices
    }
    return AVCaptureDevice.DiscoverySession(
        deviceTypes: [.externalUnknown], mediaType: .muxed, position: .unspecified
    ).devices
}

func normalizedID(_ value: String) -> String {
    value.replacingOccurrences(of: "-", with: "").lowercased()
}

protocol DeviceCapture: AnyObject {
    func start(device: AVCaptureDevice)
    func stop()
}

final class PreviewControlsModel: ObservableObject {
    @Published var screenshotEnabled = false
    @Published var recordEnabled = false
    @Published var pauseEnabled = false
    @Published var paused = false
    @Published var recording = false
    var screenshot: () -> Void = {}
    var record: () -> Void = {}
    var pause: () -> Void = {}
}

struct PreviewControlsView: View {
    @ObservedObject var model: PreviewControlsModel

    private var screenshotButton: some View {
        Button(action: model.screenshot) {
            Image(systemName: "camera")
                .font(.system(size: 19, weight: .medium))
                .frame(width: 28, height: 28)
        }
        .disabled(!model.screenshotEnabled)
        .help("Take screenshot")
        .accessibilityLabel("Take screenshot")
        .accessibilityIdentifier("preview.screenshot")
    }

    private var recordButton: some View {
        Button(action: model.record) {
            Image(systemName: model.recording ? "stop.fill" : "record.circle")
                .font(.system(size: 24, weight: .regular))
                .frame(width: 32, height: 32)
        }
        .disabled(!model.recordEnabled)
        .help(model.recording ? "Stop recording" : "Start recording")
        .accessibilityLabel(model.recording ? "Stop recording" : "Start recording")
        .accessibilityIdentifier("preview.record")
    }

    private var pauseButton: some View {
        Button(action: model.pause) {
            Image(systemName: model.paused ? "play.fill" : "pause.fill")
                .font(.system(size: 18, weight: .medium))
                .frame(width: 28, height: 28)
        }
        .disabled(!model.pauseEnabled)
        .help(model.paused ? "Resume preview" : "Pause preview")
        .accessibilityLabel(model.paused ? "Resume preview" : "Pause preview")
        .accessibilityIdentifier("preview.pause")
    }

    var body: some View {
        Group {
            #if compiler(>=6.2)
            if #available(macOS 26.0, *) {
                HStack(spacing: 16) {
                    screenshotButton.buttonStyle(.glass).frame(width: 52, height: 56)
                    recordButton.buttonStyle(.glassProminent).tint(.red).frame(width: 56, height: 56)
                    pauseButton.buttonStyle(.glass).frame(width: 52, height: 56)
                }
                .buttonBorderShape(.circle)
            } else { fallback }
            #else
            fallback
            #endif
        }
        .controlSize(.large)
        .frame(width: 216, height: 64)
    }

    private var fallback: some View {
        HStack(spacing: 16) {
            screenshotButton.buttonStyle(.bordered).frame(width: 52, height: 56)
            recordButton.buttonStyle(.borderedProminent).tint(.red).frame(width: 56, height: 56)
            pauseButton.buttonStyle(.bordered).frame(width: 52, height: 56)
        }
    }
}

final class DevicePreview: NSObject, DeviceCapture, NSWindowDelegate, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureFileOutputRecordingDelegate {
    let window: NSWindow
    let imageView = NSImageView()
    let controls: NSHostingView<PreviewControlsView>
    let captureControls: PreviewControlsModel
    private let status = NSTextField(labelWithString: "Connecting...")
    private let statusDot = NSImageView()
    private let session = AVCaptureSession()
    private let frames = AVCaptureVideoDataOutput()
    private let movie = AVCaptureMovieFileOutput()
    private let captureQueue = DispatchQueue(label: "com.finstadproductions.mauideploy.preview")
    private let imageContext = CIContext(options: [.cacheIntermediates: false])
    private let frameLock = NSLock()
    private var framePending = false
    private var paused = false
    private var live = false
    private var disconnected = false
    private var closing = false
    private var deviceObserver: NSObjectProtocol?
    private var signalSources: [DispatchSourceSignal] = []
    private var capturePending = false
    private enum RecordingState { case idle, requested, recording, finalizing, ready }
    private var recordingState = RecordingState.idle
    private var recordingURL: URL?
    private var recordingTimer: Timer?
    private var recordingStartedAt: Date?
    private var movieExport: AVAssetExportSession?
    private var displayedAspectRatio: CGFloat?
    private static let headerHeight: CGFloat = 52
    private static let footerHeight: CGFloat = 80

    init(name: String, alwaysOnTop: Bool = false) {
        let model = PreviewControlsModel()
        captureControls = model
        controls = NSHostingView(rootView: PreviewControlsView(model: model))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 410, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        model.screenshot = { [weak self] in self?.takeScreenshot() }
        model.record = { [weak self] in self?.toggleRecording() }
        model.pause = { [weak self] in self?.togglePause() }
        window.title = "MAUI Deploy - \(name)"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.minSize = NSSize(width: 280, height: 400)
        window.collectionBehavior = [.fullScreenNone]
        window.standardWindowButton(.zoomButton)?.isHidden = true
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = alwaysOnTop ? .floating : .normal
        if let visible = NSScreen.main?.visibleFrame {
            window.setContentSize(NSSize(width: min(410, visible.width - 40), height: min(800, visible.height - 80)))
        }
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        imageView.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.black.cgColor
        imageView.setAccessibilityLabel("Device screen")
        status.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingTail
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusDot.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)
        statusDot.contentTintColor = .tertiaryLabelColor
        statusDot.widthAnchor.constraint(equalToConstant: 6).isActive = true
        statusDot.heightAnchor.constraint(equalToConstant: 6).isActive = true
        let statusRow = NSStackView(views: [statusDot, status])
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = 5
        let title = NSTextField(labelWithString: name)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        title.alignment = .center
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let header = NSView()
        let heading = NSStackView(views: [title, statusRow])
        heading.orientation = .vertical
        heading.alignment = .centerX
        heading.spacing = 3
        let backdrop = NSVisualEffectView()
        backdrop.material = .underWindowBackground
        backdrop.blendingMode = .behindWindow
        backdrop.state = .active
        guard let content = window.contentView else { return }
        for view in [backdrop, imageView, header, controls] {
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
        }
        heading.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(heading)
        NSLayoutConstraint.activate([
            backdrop.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            backdrop.topAnchor.constraint(equalTo: content.topAnchor),
            backdrop.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            header.topAnchor.constraint(equalTo: content.topAnchor),
            header.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: Self.headerHeight),
            heading.centerYAnchor.constraint(equalTo: header.centerYAnchor, constant: 1),
            heading.centerXAnchor.constraint(equalTo: header.centerXAnchor, constant: 20),
            heading.leadingAnchor.constraint(greaterThanOrEqualTo: header.leadingAnchor, constant: 72),
            heading.trailingAnchor.constraint(lessThanOrEqualTo: header.trailingAnchor, constant: -16),
            imageView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: header.bottomAnchor),
            imageView.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -Self.footerHeight),
            controls.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            controls.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8),
            controls.widthAnchor.constraint(equalToConstant: 216),
            controls.heightAnchor.constraint(equalToConstant: 64),
            title.widthAnchor.constraint(lessThanOrEqualTo: heading.widthAnchor),
            statusRow.widthAnchor.constraint(lessThanOrEqualTo: heading.widthAnchor)
        ])
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume()
            signalSources.append(source)
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        let quit = NSMenuItem(title: "Quit Live Preview", action: #selector(closePreview), keyEquivalent: "q")
        quit.target = self
        appMenu.addItem(quit)
        appItem.submenu = appMenu
        NSApplication.shared.mainMenu = menu
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func updateStatus(_ event: String) {
        let labels = ["preparing": "Connecting...", "waitingForUsb": "Waiting for USB", "waitingForPermission": "Camera permission",
            "starting": "Connecting...", "started": "Live", "paused": "Paused", "resumed": "Live", "disconnected": "Disconnected",
            "screenshotRequested": "Taking screenshot...", "recordRequested": "Starting recording...",
            "screenshotComplete": "Screenshot copied", "captureFailed": "Capture failed",
            "recordingFinalizing": "Finishing recording...", "recordingReady": "Recording ready"]
        if let label = labels[event] {
            status.stringValue = label
            status.toolTip = label
        }
        statusDot.contentTintColor = event == "started" || event == "resumed" ? .systemGreen
            : event == "paused" ? .systemOrange : .tertiaryLabelColor
    }

    func completeCapture(success: Bool) {
        capturePending = false
        updateButtons()
        updateStatus(success ? "screenshotComplete" : "captureFailed")
    }

    private func updateButtons() {
        captureControls.screenshotEnabled = live && !closing && !capturePending
        captureControls.recordEnabled = live && !closing && !capturePending && (recordingState == .idle || recordingState == .recording)
        captureControls.pauseEnabled = live && !closing
        captureControls.paused = paused
        captureControls.recording = recordingState == .recording
    }

    func start(device: AVCaptureDevice) {
        disconnected = false
        emit(["event": "starting"])
        deviceObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: .main
        ) { [weak self] _ in
            self?.disconnect()
        }
        captureQueue.async {
            do {
                let input = try AVCaptureDeviceInput(device: device)
                self.session.beginConfiguration()
                if self.session.canSetSessionPreset(.high) { self.session.sessionPreset = .high }
                guard self.session.canAddInput(input), self.session.canAddOutput(self.frames) else { fail("CAPTURE_UNAVAILABLE") }
                self.session.addInput(input)
                self.frames.alwaysDiscardsLateVideoFrames = true
                self.frames.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                self.frames.setSampleBufferDelegate(self, queue: self.captureQueue)
                self.session.addOutput(self.frames)
                if self.session.canAddOutput(self.movie) {
                    self.session.addOutput(self.movie)
                    if let connection = self.movie.connection(with: .video) {
                        self.movie.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: connection)
                    }
                    self.movie.connection(with: .audio)?.isEnabled = false
                    self.movie.maxRecordedDuration = CMTime(seconds: 180, preferredTimescale: 600)
                    self.movie.maxRecordedFileSize = 512 * 1024 * 1024
                }
                self.session.commitConfiguration()
                if device.activeFormat.videoSupportedFrameRateRanges.contains(where: {
                    $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
                }) {
                    try device.lockForConfiguration()
                    device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
                    device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
                    device.unlockForConfiguration()
                }
                self.session.startRunning()
            } catch { fail("CAPTURE_FAILED") }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        frameLock.lock()
        if framePending { frameLock.unlock(); return }
        framePending = true
        frameLock.unlock()
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            frameLock.lock(); framePending = false; frameLock.unlock()
            return
        }
        let image = CIImage(cvPixelBuffer: pixels)
        guard let rendered = imageContext.createCGImage(image, from: image.extent) else {
            frameLock.lock(); framePending = false; frameLock.unlock()
            return
        }
        DispatchQueue.main.async {
            defer { self.frameLock.lock(); self.framePending = false; self.frameLock.unlock() }
            self.presentFrame(rendered)
        }
    }

    func presentFrame(_ image: CGImage) {
        guard !closing && !disconnected else { return }
        if !live {
            live = true
            updateButtons()
            updateStatus("started")
            emit(["event": "started"])
        }
        if !paused {
            imageView.image = NSImage(cgImage: image, size: .zero)
            let aspectRatio = CGFloat(image.width) / CGFloat(image.height)
            if displayedAspectRatio == nil || abs(aspectRatio - displayedAspectRatio!) > 0.01 {
                displayedAspectRatio = aspectRatio
                fitDevice(aspectRatio: aspectRatio)
            }
        }
    }

    private func fitDevice(aspectRatio: CGFloat) {
        guard let screen = window.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame.insetBy(dx: 20, dy: 20)
        let chrome = Self.headerHeight + Self.footerHeight
        let maximum = window.contentRect(forFrameRect: visible).size
        let height = min(800, maximum.height)
        let width = max(280, min(aspectRatio > 1 ? 900 : 430, maximum.width, (height - chrome) * aspectRatio).rounded(.down))
        let size = NSSize(width: width, height: max(400, (width / aspectRatio).rounded() + chrome))
        let center = NSPoint(x: window.frame.midX, y: window.frame.midY)
        window.setContentSize(size)
        let origin = NSPoint(
            x: min(max(center.x - window.frame.width / 2, visible.minX), visible.maxX - window.frame.width),
            y: min(max(center.y - window.frame.height / 2, visible.minY), visible.maxY - window.frame.height)
        )
        window.setFrameOrigin(NSPoint(x: origin.x.rounded(.down), y: origin.y.rounded(.down)))
    }

    func disconnect() {
        disconnected = true
        live = false
        imageView.image = nil
        recordingTimer?.invalidate()
        updateButtons()
        updateStatus("disconnected")
        emit(["event": "disconnected"])
        captureQueue.async {
            self.frames.setSampleBufferDelegate(nil, queue: nil)
            self.session.stopRunning()
        }
    }

    @objc func togglePause() {
        guard live else { return }
        paused.toggle()
        updateButtons()
        updateStatus(paused ? "paused" : "resumed")
        emit(["event": paused ? "paused" : "resumed"])
    }

    @objc func takeScreenshot() {
        guard live && !capturePending && !closing else { return }
        capturePending = true
        updateButtons()
        updateStatus("screenshotRequested")
        guard let image = imageView.image?.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]),
              data.count <= 32 * 1024 * 1024 else {
            completeCapture(success: false)
            return
        }
        emit(["event": "screenshot", "image": data.base64EncodedString()])
    }

    @objc func toggleRecording() {
        guard live && !capturePending && !closing else { return }
        if recordingState == .recording {
            recordingState = .finalizing
            recordingTimer?.invalidate()
            updateButtons()
            updateStatus("recordingFinalizing")
            emit(["event": "recordingFinalizing"])
            captureQueue.async { self.movie.stopRecording() }
        } else if recordingState == .idle {
            recordingState = .requested
            updateButtons()
            updateStatus("recordRequested")
            emit(["event": "recordRequested"])
        }
    }

    func startRecording(to destination: URL) {
        guard recordingState == .requested && live && !closing else { return }
        let temporary = destination.deletingPathExtension().appendingPathExtension("mov")
        guard destination.pathExtension == "mp4",
              !FileManager.default.fileExists(atPath: destination.path),
              !FileManager.default.fileExists(atPath: temporary.path) else {
            recordingFailed()
            return
        }
        recordingURL = destination
        captureQueue.async {
            guard self.session.isRunning && self.movie.connection(with: .video) != nil else {
                DispatchQueue.main.async { self.recordingFailed() }
                return
            }
            self.movie.startRecording(to: temporary, recordingDelegate: self)
        }
    }

    func completeRecording(success: Bool) {
        recordingState = .idle
        recordingURL = nil
        recordingTimer?.invalidate()
        recordingTimer = nil
        recordingStartedAt = nil
        updateButtons()
        updateStatus(success ? "recordingReady" : "captureFailed")
    }

    private func recordingFailed() {
        completeRecording(success: false)
        emit(["event": "recordingFailed"])
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        DispatchQueue.main.async {
            guard !self.closing else { return }
            self.recordingState = .recording
            self.recordingStartedAt = Date()
            self.updateButtons()
            self.updateRecordingTime()
            self.recordingTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateRecordingTime() }
            emit(["event": "recordingStarted"])
        }
    }

    private func updateRecordingTime() {
        guard let start = recordingStartedAt, recordingState == .recording else { return }
        let seconds = max(0, Int(Date().timeIntervalSince(start)))
        status.stringValue = String(format: "%02d:%02d", seconds / 60, seconds % 60)
        status.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        statusDot.contentTintColor = .systemRed
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo fileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        DispatchQueue.main.async {
            guard !self.closing, let destination = self.recordingURL else { return }
            self.recordingState = .finalizing
            self.recordingTimer?.invalidate()
            self.updateButtons()
            self.updateStatus("recordingFinalizing")
            emit(["event": "recordingFinalizing"])
            if let failure = error as NSError?, failure.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool != true {
                self.recordingFailed()
                return
            }
            let asset = AVURLAsset(url: fileURL)
            guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
                self.recordingFailed()
                return
            }
            self.movieExport = export
            export.outputURL = destination
            export.outputFileType = .mp4
            export.shouldOptimizeForNetworkUse = true
            export.exportAsynchronously {
                DispatchQueue.main.async {
                    guard !self.closing else { return }
                    self.movieExport = nil
                    guard export.status == .completed else { self.recordingFailed(); return }
                    try? FileManager.default.removeItem(at: fileURL)
                    self.recordingState = .ready
                    self.updateStatus("recordingReady")
                    emit(["event": "recordingReady"])
                }
            }
        }
    }

    @objc func closePreview() { window.close() }

    func windowWillClose(_ notification: Notification) { stop() }

    func stop() {
        guard !closing else { return }
        closing = true
        imageView.image = nil
        recordingTimer?.invalidate()
        movieExport?.cancelExport()
        FileHandle.standardInput.readabilityHandler = nil
        captureQueue.async {
            self.session.stopRunning()
            exit(0)
        }
    }
}

final class ScreenRecorder: NSObject, DeviceCapture, AVCaptureFileOutputRecordingDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let destination: URL
    private let temporary: URL
    private var signalSources: [DispatchSourceSignal] = []
    private var stopRequested = false
    private var started = false
    private var exporting = false
    private var deviceObserver: NSObjectProtocol?

    init(destination: URL) {
        self.destination = destination
        self.temporary = destination.deletingPathExtension().appendingPathExtension("mov")
        super.init()
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume()
            signalSources.append(source)
        }
    }

    func start(device: AVCaptureDevice) {
        guard !stopRequested else { exit(0) }
        emit(["event": "starting"])
        do {
            let input = try AVCaptureDeviceInput(device: device)
            session.beginConfiguration()
            if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
            guard session.canAddInput(input), session.canAddOutput(output) else {
                fail("CAPTURE_UNAVAILABLE")
            }
            session.addInput(input)
            session.addOutput(output)
            if let connection = output.connection(with: .video) {
                output.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: connection)
            } else {
                fail("H264_UNAVAILABLE")
            }
            output.connection(with: .audio)?.isEnabled = false
            if device.activeFormat.videoSupportedFrameRateRanges.contains(where: {
                $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
            }) {
                try device.lockForConfiguration()
                device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
                device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
                device.unlockForConfiguration()
            }
            output.maxRecordedDuration = CMTime(seconds: 180, preferredTimescale: 600)
            output.maxRecordedFileSize = 512 * 1024 * 1024
            session.commitConfiguration()
            deviceObserver = NotificationCenter.default.addObserver(
                forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: .main
            ) { _ in fail("DEVICE_DISCONNECTED") }
            session.startRunning()
            output.startRecording(to: temporary, recordingDelegate: self)
        } catch {
            fail("CAPTURE_FAILED")
        }
    }

    func stop() {
        stopRequested = true
        if !started && !output.isRecording { exit(0) }
        if started && !exporting { output.stopRecording() }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        DispatchQueue.main.async {
            self.started = true
            emit(["event": "started"])
            if self.stopRequested { self.output.stopRecording() }
        }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo fileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        DispatchQueue.main.async {
            self.exporting = true
            self.session.stopRunning()
            if let failure = error as NSError?,
               failure.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool != true {
                fail("RECORDING_FAILED")
            }
            emit(["event": "finalizing"])
            let asset = AVURLAsset(url: fileURL)
            guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
                fail("EXPORT_UNAVAILABLE")
            }
            export.outputURL = self.destination
            export.outputFileType = .mp4
            export.shouldOptimizeForNetworkUse = true
            export.exportAsynchronously {
                guard export.status == .completed else { fail("EXPORT_FAILED") }
                try? FileManager.default.removeItem(at: self.temporary)
                emit(["event": "finished"])
                exit(0)
            }
        }
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 2 && arguments[1] == "list"
    || arguments.count == 4 && ["record", "preview"].contains(arguments[1])
    || arguments.count == 5 && arguments[1] == "preview" && arguments[4] == "--always-on-top"
else { fail("INVALID_ARGUMENTS") }
enableDeviceScreens()

if arguments[1] == "list" {
    emit(["devices": screenDevices().map { ["id": $0.uniqueID, "name": $0.localizedName] }])
    exit(0)
}

let recorder: DeviceCapture
if arguments[1] == "preview" {
    NSApplication.shared.setActivationPolicy(.regular)
    let preview = DevicePreview(name: arguments[3], alwaysOnTop: arguments.count == 5)
    previewStatus = { [weak preview] event in preview?.updateStatus(event) }
    recorder = preview
} else {
    let destination = URL(fileURLWithPath: arguments[3])
    guard destination.pathExtension == "mp4",
          !FileManager.default.fileExists(atPath: destination.path),
          !FileManager.default.fileExists(atPath: destination.deletingPathExtension().appendingPathExtension("mov").path)
    else { fail("INVALID_DESTINATION") }
    recorder = ScreenRecorder(destination: destination)
}
let targetID = normalizedID(arguments[2])
var selectedScreenID: String?
var previousScreens: [[String: String]]?
var found = false
emit(["event": "preparing"])

func startIfAvailable() -> Bool {
    if found { return true }
    let devices = screenDevices()
    let selectedID = selectedScreenID.map(normalizedID) ?? targetID
    guard let device = devices.first(where: { normalizedID($0.uniqueID) == selectedID }) else {
        let screens = devices.sorted { $0.uniqueID < $1.uniqueID }.map { ["id": $0.uniqueID, "name": $0.localizedName] }
        if screens != previousScreens {
            previousScreens = screens
            emit(["event": "screens", "devices": screens])
            if screens.isEmpty { emit(["event": "waitingForUsb"]) }
        }
        return false
    }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        recorder.start(device: device)
    case .notDetermined:
        emit(["event": "waitingForPermission"])
        AVCaptureDevice.requestAccess(for: .video) { allowed in
            DispatchQueue.main.async {
                guard allowed else { fail("PERMISSION_DENIED") }
                recorder.start(device: device)
            }
        }
    default:
        fail("PERMISSION_DENIED")
    }
    return true
}

var selectionInput = Data()
FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { handle.readabilityHandler = nil }
    DispatchQueue.main.async {
        if data.isEmpty { recorder.stop(); return }
        selectionInput.append(data)
        if selectionInput.count > 64 * 1024 { fail("INVALID_ARGUMENTS") }
        while let newline = selectionInput.firstIndex(of: 10) {
            let line = Data(selectionInput.prefix(upTo: newline))
            selectionInput.removeSubrange(...newline)
            guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: String] else { fail("INVALID_ARGUMENTS") }
            if let identifier = request["screenId"] {
                if !found {
                    selectedScreenID = identifier
                    found = startIfAvailable()
                }
            } else if let preview = recorder as? DevicePreview {
                switch request["action"] {
                case "screenshotComplete": preview.completeCapture(success: request["success"] == "true")
                case "startRecording":
                    guard let destination = request["path"] else { fail("INVALID_ARGUMENTS") }
                    preview.startRecording(to: URL(fileURLWithPath: destination))
                case "recordingComplete": preview.completeRecording(success: request["success"] == "true")
                default: fail("INVALID_ARGUMENTS")
                }
            } else {
                fail("INVALID_ARGUMENTS")
            }
        }
    }
}

var discoveryObserver: NSObjectProtocol?
var discoveryTimer: DispatchSourceTimer?
found = startIfAvailable()
if !found {
    discoveryObserver = NotificationCenter.default.addObserver(
        forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: .main
    ) { _ in
        if !found { found = startIfAvailable() }
    }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler {
        if !found { found = startIfAvailable() }
        if found {
            timer.cancel()
            if let observer = discoveryObserver { NotificationCenter.default.removeObserver(observer) }
        }
    }
    discoveryTimer = timer
    timer.resume()
}
if arguments[1] == "preview" { NSApplication.shared.run() } else { dispatchMain() }