@preconcurrency import AVFoundation
import CoreMediaIO
import Darwin
import Foundation

func emit(_ fields: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: fields) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
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

final class ScreenRecorder: NSObject, AVCaptureFileOutputRecordingDelegate {
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
    || arguments.count == 4 && arguments[1] == "record" else { fail("INVALID_ARGUMENTS") }
enableDeviceScreens()

if arguments[1] == "list" {
    emit(["devices": screenDevices().map { ["id": $0.uniqueID, "name": $0.localizedName] }])
    exit(0)
}

let destination = URL(fileURLWithPath: arguments[3])
guard destination.pathExtension == "mp4",
      !FileManager.default.fileExists(atPath: destination.path),
      !FileManager.default.fileExists(atPath: destination.deletingPathExtension().appendingPathExtension("mov").path)
else { fail("INVALID_DESTINATION") }

let recorder = ScreenRecorder(destination: destination)
let targetID = normalizedID(arguments[2])
emit(["event": "preparing"])

func startIfAvailable() -> Bool {
    guard let device = screenDevices().first(where: { normalizedID($0.uniqueID) == targetID }) else { return false }
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

var discoveryObserver: NSObjectProtocol?
var discoveryTimer: DispatchSourceTimer?
var found = startIfAvailable()
if !found {
    emit(["event": "waitingForUsb"])
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
dispatchMain()