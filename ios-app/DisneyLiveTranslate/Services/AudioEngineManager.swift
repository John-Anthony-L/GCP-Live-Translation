import Foundation
import AVFoundation

public protocol AudioEngineDelegate: AnyObject {
    func didCapturePcmChunk(base64Pcm: String)
}

public class AudioEngineManager: NSObject {
    public static let shared = AudioEngineManager()
    public weak var delegate: AudioEngineDelegate?

    private var audioEngine = AVAudioEngine()
    private var playerNode = AVAudioPlayerNode()
    private var outputAudioFormat: AVAudioFormat?
    private var isRecording = false

    public override init() {
        super.init()
        setupAudioSession()
        setupAudioPlayer()
    }

    private func setupAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            print("[AudioEngine] Error configuring AVAudioSession: \(error)")
        }
    }

    private func setupAudioPlayer() {
        audioEngine.attach(playerNode)
        
        // Output format: 24kHz Mono 16-bit PCM (standard Gemini Live output)
        outputAudioFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)
        
        if let format = outputAudioFormat {
            audioEngine.connect(playerNode, to: audioEngine.mainMixerNode, format: format)
        }

        do {
            try audioEngine.start()
            playerNode.play()
        } catch {
            print("[AudioEngine] Failed to start audio engine for playback: \(error)")
        }
    }

    public func startCapture() {
        guard !isRecording else { return }
        
        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        // Downsample input to 16kHz Mono 16-bit PCM
        guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let formatConverter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            print("[AudioEngine] Failed to create audio format converter")
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] (buffer, when) in
            guard let self = self else { return }

            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000.0 / inputFormat.sampleRate)
            guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

            var error: NSError?
            let status = formatConverter.convert(to: convertedBuffer, error: &error) { inNumPackets, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }

            if status == .haveData, let channelData = convertedBuffer.int16ChannelData {
                let byteCount = Int(convertedBuffer.frameLength) * MemoryLayout<Int16>.size
                let data = Data(bytes: channelData[0], count: byteCount)
                let base64String = data.base64EncodedString()
                self.delegate?.didCapturePcmChunk(base64Pcm: base64String)
            }
        }

        isRecording = true
        print("[AudioEngine] Audio capture started (16kHz PCM)")
    }

    public func stopCapture() {
        guard isRecording else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        isRecording = false
        print("[AudioEngine] Audio capture stopped")
    }

    public func playReceivedPcmChunk(base64Pcm: String, sampleRate: Double = 24000) {
        guard let pcmData = Data(base64Encoded: base64Pcm),
              let outputFormat = outputAudioFormat else { return }

        let frameCount = UInt32(pcmData.count / 2) // 16-bit mono = 2 bytes per frame
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCount) else { return }
        pcmBuffer.frameLength = frameCount

        pcmData.withUnsafeBytes { rawBuffer in
            guard let int16Pointer = rawBuffer.bindMemory(to: Int16.self).baseAddress else { return }
            let floatChannelData = pcmBuffer.floatChannelData![0]
            for i in 0..<Int(frameCount) {
                floatChannelData[i] = Float(int16Pointer[i]) / 32768.0
            }
        }

        playerNode.scheduleBuffer(pcmBuffer, completionHandler: nil)
        if !playerNode.isPlaying {
            playerNode.play()
        }
    }

    public func interruptPlayback() {
        playerNode.stop()
        playerNode.play()
    }
}
