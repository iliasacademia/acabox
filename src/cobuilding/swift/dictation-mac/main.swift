// dictation-mac — on-device speech-to-text helper for Acabox.
//
// Anthropic has no speech-to-text API and Claude takes no audio input, so
// dictation cannot come from the Agent SDK. Chromium's Web Speech API is not an
// option either: Electron ships no SODA models (no `libsoda`, no model files in
// electron/dist), so its on-device path cannot run, and its network path would
// POST the microphone to Google — wrong for an app whose whole premise is that
// research data stays on the machine. So recognition happens here, locally,
// against Apple's Speech framework.
//
// Long-lived child process spawned by `main/dictationService.ts`. Speaks
// newline-delimited JSON both ways so the host never has to parse a stream
// format; one object per line, flushed immediately.
//
//   stdin   {"cmd":"start","locale":"en-US"}  {"cmd":"stop"}  {"cmd":"quit"}
//   stdout  {"type":"ready",...} {"type":"partial",...} {"type":"final",...}
//           {"type":"level",...} {"type":"error",...}    {"type":"stopped"}
//
// `--probe` prints one capability line and exits. That path deliberately
// touches neither the microphone nor the recognizer, so the host can decide
// whether to show the mic button WITHOUT triggering a TCC prompt — the button
// must not be what asks for permission.
//
// Two engines behind one protocol:
//   * SpeechTranscriber/SpeechAnalyzer (macOS 26+) — the dictation-grade API,
//     with volatile results that revise as you keep talking.
//   * SFSpeechRecognizer (macOS 10.15+) — fallback. Same JSON out; the host
//     cannot tell them apart except by the `engine` field on `ready`.

import AVFoundation
import Foundation
import Speech

// MARK: - Wire protocol

/// stdout is the protocol, so nothing else may ever write to it — diagnostics
/// go to stderr, which the host logs but never parses.
private let stdoutLock = NSLock()

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    stdoutLock.lock()
    FileHandle.standardOutput.write(Data(line.utf8))
    stdoutLock.unlock()
}

func emitError(_ code: String, _ message: String) {
    emit(["type": "error", "code": code, "message": message])
}

func note(_ message: String) {
    FileHandle.standardError.write(Data("[dictation] \(message)\n".utf8))
}

// MARK: - Engine

protocol DictationEngine: AnyObject {
    func start() async throws
    func stop() async
}

/// Thrown where the failure is the user's to resolve (permission, missing
/// model) rather than a bug — the host maps `code` to specific UI copy.
struct DictationError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

// MARK: - Audio level

/// Root-mean-square of a buffer, mapped to 0...1 for the UI's level meter.
/// Emitted at ~12 Hz — enough for a responsive meter, rare enough that the
/// level stream never competes with transcript lines on stdout.
final class LevelMeter {
    private var lastEmit = Date.distantPast
    private let interval: TimeInterval = 1.0 / 12.0

    func consider(_ buffer: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastEmit) >= interval else { return }
        lastEmit = now

        guard let channel = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }

        var sum: Float = 0
        for i in 0..<count { sum += channel[i] * channel[i] }
        let rms = (sum / Float(count)).squareRoot()

        // Speech sits low in linear RMS; a dB curve is what makes the meter
        // move visibly instead of hugging zero.
        let db = 20 * log10(max(rms, 1e-7))
        let normalized = max(0, min(1, (db + 50) / 50))
        emit(["type": "level", "rms": Double(normalized)])
    }
}

// MARK: - Modern engine (macOS 26+)

@available(macOS 26.0, *)
final class TranscriberEngine: DictationEngine {
    private let locale: Locale
    private let audioEngine = AVAudioEngine()
    private let meter = LevelMeter()

    private var transcriber: SpeechTranscriber?
    private var analyzer: SpeechAnalyzer?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var converter: AVAudioConverter?
    private var analyzerFormat: AVAudioFormat?

    /// Text the recognizer has committed. Volatile results revise only the
    /// tail, so the host is always sent `finalized + volatile` and can replace
    /// its buffer wholesale rather than trying to diff.
    private var finalizedText = ""

    init(locale: Locale) {
        self.locale = locale
    }

    func start() async throws {
        // `.progressiveTranscription` is the preset that reports volatile
        // results; plain `.transcription` returns nothing until you stop
        // talking, which reads as a hang in a text field.
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        self.transcriber = transcriber

        try await ensureModelInstalled(for: transcriber)

        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw DictationError(code: "no-audio-format", message: "No compatible audio format for on-device transcription.")
        }
        analyzerFormat = format

        let (stream, builder) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = builder

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer

        resultsTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    if result.isFinal {
                        self.finalizedText += text
                        emit(["type": "partial", "text": self.finalizedText])
                    } else {
                        emit(["type": "partial", "text": self.finalizedText + text])
                    }
                }
            } catch {
                // Cancellation on stop is the normal exit from this loop, not
                // a failure worth surfacing to the user.
                if !(error is CancellationError) {
                    emitError("results-failed", error.localizedDescription)
                }
            }
        }

        try startCapture(into: builder, targetFormat: format)
        try await analyzer.start(inputSequence: stream)
        emit(["type": "listening"])
    }

    /// macOS ships some locales' models and downloads the rest on demand. The
    /// download is reported so a first-run user on an uninstalled locale sees
    /// "preparing" instead of a mic button that appears to do nothing.
    private func ensureModelInstalled(for transcriber: SpeechTranscriber) async throws {
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
            return
        }
        emit(["type": "installing", "locale": locale.identifier])
        try await request.downloadAndInstall()
        emit(["type": "installed", "locale": locale.identifier])
    }

    private func startCapture(into builder: AsyncStream<AnalyzerInput>.Continuation, targetFormat: AVAudioFormat) throws {
        let input = audioEngine.inputNode
        let nodeFormat = input.outputFormat(forBus: 0)
        guard nodeFormat.sampleRate > 0 else {
            throw DictationError(code: "no-input-device", message: "No microphone input is available.")
        }

        // The analyzer's preferred format is rarely the device's native one, so
        // resample rather than hand it buffers it will reject.
        if !nodeFormat.isEqual(targetFormat) {
            guard let conv = AVAudioConverter(from: nodeFormat, to: targetFormat) else {
                throw DictationError(code: "no-converter", message: "Cannot convert microphone audio to the required format.")
            }
            converter = conv
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: nodeFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.meter.consider(buffer)
            guard let converted = self.convert(buffer, to: targetFormat) else { return }
            builder.yield(AnalyzerInput(buffer: converted))
        }

        audioEngine.prepare()
        try audioEngine.start()
    }

    private func convert(_ buffer: AVAudioPCMBuffer, to targetFormat: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let converter else { return buffer }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return nil }

        // The tap hands us one buffer per callback, so the input block supplies
        // it once and then reports end-of-stream; returning it repeatedly would
        // duplicate audio.
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }

        if let error {
            note("convert failed: \(error.localizedDescription)")
            return nil
        }
        return out.frameLength > 0 ? out : nil
    }

    func stop() async {
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        inputBuilder?.finish()

        // Flush whatever is still in flight so the last word of an utterance
        // isn't dropped when the user releases the button mid-sentence.
        if let analyzer {
            do { try await analyzer.finalizeAndFinishThroughEndOfInput() }
            catch { note("finalize failed: \(error.localizedDescription)") }
        }
        resultsTask?.cancel()
        _ = await resultsTask?.value

        emit(["type": "final", "text": finalizedText])
        finalizedText = ""
        converter = nil
        analyzer = nil
        transcriber = nil
        inputBuilder = nil
        resultsTask = nil
    }
}

// MARK: - Legacy engine (macOS 10.15+)

final class LegacyEngine: DictationEngine {
    private let locale: Locale
    private let audioEngine = AVAudioEngine()
    private let meter = LevelMeter()

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var latestText = ""

    init(locale: Locale) {
        self.locale = locale
    }

    func start() async throws {
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            throw DictationError(code: "locale-unsupported", message: "Speech recognition is unavailable for \(locale.identifier).")
        }
        guard recognizer.isAvailable else {
            throw DictationError(code: "recognizer-unavailable", message: "The speech recognizer is temporarily unavailable.")
        }
        self.recognizer = recognizer

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Keep audio on the machine even though the cloud path would be more
        // accurate — the whole point of this feature is that it stays local.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.latestText = result.bestTranscription.formattedString
                emit(["type": "partial", "text": self.latestText])
            }
            if let error {
                let ns = error as NSError
                // 216 / 301 are the ordinary "task was cancelled" codes raised
                // by our own stop(); reporting them would show the user an
                // error every time they finish dictating.
                if ns.code != 216 && ns.code != 301 {
                    emitError("recognition-failed", error.localizedDescription)
                }
            }
        }

        let input = audioEngine.inputNode
        let nodeFormat = input.outputFormat(forBus: 0)
        guard nodeFormat.sampleRate > 0 else {
            throw DictationError(code: "no-input-device", message: "No microphone input is available.")
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: nodeFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.meter.consider(buffer)
            self.request?.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()
        emit(["type": "listening"])
    }

    func stop() async {
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        request?.endAudio()

        // No completion signal to await here, so give the recognizer a brief
        // window to emit the tail of the utterance before we finalize.
        try? await Task.sleep(nanoseconds: 400_000_000)

        task?.cancel()
        emit(["type": "final", "text": latestText])
        latestText = ""
        task = nil
        request = nil
        recognizer = nil
    }
}

// MARK: - Permissions

func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
    if SFSpeechRecognizer.authorizationStatus() != .notDetermined {
        return SFSpeechRecognizer.authorizationStatus()
    }
    return await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
}

func requestMicrophoneAuthorization() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
    default: return false
    }
}

// MARK: - Session

/// Owns the single active engine. Serialized through an actor so a `stop`
/// arriving while `start` is still awaiting model installation can't leave a
/// half-built engine running with no way to shut it down.
actor Session {
    private var engine: DictationEngine?

    func start(localeIdentifier: String) async {
        guard engine == nil else {
            emitError("already-running", "Dictation is already running.")
            return
        }

        guard await requestMicrophoneAuthorization() else {
            emitError("mic-denied", "Microphone access is denied. Enable it in System Settings › Privacy & Security › Microphone.")
            return
        }
        guard await requestSpeechAuthorization() == .authorized else {
            emitError("speech-denied", "Speech recognition access is denied. Enable it in System Settings › Privacy & Security › Speech Recognition.")
            return
        }

        let locale = Locale(identifier: localeIdentifier)
        let engine: DictationEngine
        var engineName: String
        if #available(macOS 26.0, *), await supportsTranscriber(locale) {
            engine = TranscriberEngine(locale: locale)
            engineName = "transcriber"
        } else {
            engine = LegacyEngine(locale: locale)
            engineName = "sfspeech"
        }

        do {
            try await engine.start()
            self.engine = engine
            emit(["type": "ready", "engine": engineName, "locale": localeIdentifier])
        } catch let e as DictationError {
            emitError(e.code, e.message)
        } catch {
            emitError("start-failed", error.localizedDescription)
        }
    }

    func stop() async {
        guard let engine else {
            emit(["type": "stopped"])
            return
        }
        self.engine = nil
        await engine.stop()
        emit(["type": "stopped"])
    }

    @available(macOS 26.0, *)
    private func supportsTranscriber(_ locale: Locale) async -> Bool {
        let wanted = locale.identifier(.bcp47)
        return await SpeechTranscriber.supportedLocales
            .contains { $0.identifier(.bcp47) == wanted }
    }
}

// MARK: - Capability probe

/// Answers "should the mic button exist at all" without touching the
/// microphone or the recognizer, so nothing here can raise a TCC prompt.
func probe(localeIdentifier: String) async {
    var payload: [String: Any] = [
        "type": "probe",
        "locale": localeIdentifier,
        "micAuth": authName(AVCaptureDevice.authorizationStatus(for: .audio)),
        "speechAuth": speechAuthName(SFSpeechRecognizer.authorizationStatus()),
    ]

    let locale = Locale(identifier: localeIdentifier)
    if let recognizer = SFSpeechRecognizer(locale: locale) {
        payload["sfAvailable"] = recognizer.isAvailable
        payload["sfOnDevice"] = recognizer.supportsOnDeviceRecognition
    } else {
        payload["sfAvailable"] = false
        payload["sfOnDevice"] = false
    }

    if #available(macOS 26.0, *) {
        let wanted = locale.identifier(.bcp47)
        let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
        let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
        payload["engine"] = supported.contains(wanted) ? "transcriber" : "sfspeech"
        payload["modelInstalled"] = installed.contains(wanted)
    } else {
        payload["engine"] = "sfspeech"
        payload["modelInstalled"] = true
    }

    let sfOK = (payload["sfAvailable"] as? Bool) ?? false
    payload["available"] = (payload["engine"] as? String) == "transcriber" || sfOK
    emit(payload)
}

func authName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func speechAuthName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

// MARK: - Entry point

let arguments = CommandLine.arguments

if arguments.contains("--probe") {
    var locale = "en-US"
    if let i = arguments.firstIndex(of: "--locale"), i + 1 < arguments.count {
        locale = arguments[i + 1]
    }
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        await probe(localeIdentifier: locale)
        semaphore.signal()
    }
    semaphore.wait()
    exit(0)
}

let session = Session()

/// Exit is never immediate: it queues behind the Session actor so any in-flight
/// `start`/`stop` finishes first. Calling `exit(0)` straight from the stdin
/// reader raced those tasks — the helper could terminate with the audio engine
/// still running and the closing `stopped` unwritten. Caught by
/// `dictationHelper.test.ts`, which sends `stop` then `quit` and closes stdin
/// in the same tick; the reader always won.
private let shutdownLock = NSLock()
private var shutdownStarted = false

func shutdown() {
    shutdownLock.lock()
    let alreadyShuttingDown = shutdownStarted
    shutdownStarted = true
    shutdownLock.unlock()
    guard !alreadyShuttingDown else { return }

    Task {
        // The actor serializes this behind any pending command, so the audio
        // device is released and every event flushed before the process goes.
        await session.stop()
        exit(0)
    }
}

/// Reads stdin on a background thread. A closed stdin means the host is gone,
/// which must terminate the helper — otherwise a crashed Acabox leaves an
/// orphan process holding the microphone open.
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty,
              let data = line.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cmd = message["cmd"] as? String else {
            continue
        }

        switch cmd {
        case "start":
            let locale = (message["locale"] as? String) ?? "en-US"
            Task { await session.start(localeIdentifier: locale) }
        case "stop":
            Task { await session.stop() }
        case "quit":
            shutdown()
        default:
            emitError("unknown-command", "Unknown command: \(cmd)")
        }
    }
    // stdin closed — the host went away.
    shutdown()
}

emit(["type": "hello", "pid": ProcessInfo.processInfo.processIdentifier])
dispatchMain()
