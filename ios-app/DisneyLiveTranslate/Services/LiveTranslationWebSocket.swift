import Foundation
import Combine

public class LiveTranslationWebSocket: NSObject, URLSessionWebSocketDelegate, AudioEngineDelegate {
    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var session: TranslationSession
    private var lastAudioSentTime: TimeInterval = 0

    public init(session: TranslationSession) {
        self.session = session
        super.init()
        AudioEngineManager.shared.delegate = self
    }

    public func connect() {
        disconnect()

        let base = session.serverBaseUrl.replacingOccurrences(of: "http://", with: "ws://").replacingOccurrences(of: "https://", with: "wss://")
        guard let url = URL(string: "\(base)/live-translate?sourceLang=\(session.sourceLanguage)&targetLang=\(session.targetLanguage)&voice=\(session.voice)") else {
            print("[WebSocket] Invalid URL")
            return
        }

        print("[WebSocket] Connecting to: \(url)")
        urlSession = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue())
        webSocketTask = urlSession?.webSocketTask(with: url)
        webSocketTask?.resume()

        receiveNextMessage()
    }

    public func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        DispatchQueue.main.async {
            self.session.isConnected = false
            self.session.isStreaming = false
        }
    }

    public func startLiveStreaming() {
        if !session.isConnected {
            connect()
        }
        DispatchQueue.main.async {
            self.session.isStreaming = true
            self.session.resetTranscripts()
        }
        AudioEngineManager.shared.startCapture()
    }

    public func stopLiveStreaming() {
        AudioEngineManager.shared.stopCapture()
        DispatchQueue.main.async {
            self.session.isStreaming = false
        }
    }

    // AudioEngineDelegate
    public func didCapturePcmChunk(base64Pcm: String) {
        guard session.isStreaming, session.isConnected else { return }

        lastAudioSentTime = Date().timeIntervalSince1970

        let payload: [String: Any] = [
            "type": "audio",
            "pcm": base64Pcm,
            "sampleRate": 16000
        ]

        if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            let message = URLSessionWebSocketTask.Message.string(jsonString)
            webSocketTask?.send(message) { error in
                if let error = error {
                    print("[WebSocket] Error sending audio chunk: \(error)")
                }
            }
        }
    }

    private func receiveNextMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .failure(let error):
                print("[WebSocket] Receive error: \(error)")
                DispatchQueue.main.async {
                    self.session.isConnected = false
                }
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleIncomingJson(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleIncomingJson(text)
                    }
                @unknown default:
                    break
                }
                self.receiveNextMessage()
            }
        }
    }

    private func handleIncomingJson(_ jsonString: String) {
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        let type = json["type"] as? String

        DispatchQueue.main.async {
            if type == "ready" {
                self.session.isConnected = true
            } else if type == "audio", let pcm = json["pcm"] as? String {
                if let latencyMs = json["latencyMs"] as? Int, latencyMs > 0 {
                    self.session.currentLatencyMs = latencyMs
                } else if self.lastAudioSentTime > 0 {
                    let diff = Int((Date().timeIntervalSince1970 - self.lastAudioSentTime) * 1000)
                    self.session.currentLatencyMs = diff
                }
                AudioEngineManager.shared.playReceivedPcmChunk(base64Pcm: pcm)
            } else if type == "transcript", let text = json["text"] as? String {
                self.session.translatedTranscript += text
            } else if type == "interrupted" {
                AudioEngineManager.shared.interruptPlayback()
            }
        }
    }

    // URLSessionWebSocketDelegate
    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        print("[WebSocket] Connected successfully")
        DispatchQueue.main.async {
            self.session.isConnected = true
        }
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        print("[WebSocket] Closed with code: \(closeCode)")
        DispatchQueue.main.async {
            self.session.isConnected = false
            self.session.isStreaming = false
        }
    }
}
