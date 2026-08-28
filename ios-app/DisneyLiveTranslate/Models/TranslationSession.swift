import Foundation
import Combine

public enum TranslationEngine: String, CaseIterable, Identifiable {
    case geminiLive = "Gemini 2.0 Live API"
    case translationPipeline = "Translation Advanced Pipeline"
    public var id: String { rawValue }
}

public struct LanguageOption: Identifiable, Hashable {
    public let code: String
    public let name: String
    public var id: String { code }
}

public class TranslationSession: ObservableObject {
    @Published public var selectedEngine: TranslationEngine = .geminiLive
    @Published public var sourceLanguage: String = "en"
    @Published public var targetLanguage: String = "es"
    @Published public var voice: String = "Aoede"
    
    @Published public var isConnected: Bool = false
    @Published public var isStreaming: Bool = false
    @Published public var isSpeaking: Bool = false
    @Published public var continuousMode: Bool = false
    
    @Published public var speakerTranscript: String = ""
    @Published public var translatedTranscript: String = ""
    @Published public var currentLatencyMs: Int = 0
    @Published public var serverBaseUrl: String = "ws://localhost:8080"
    
    public let availableLanguages: [LanguageOption] = [
        LanguageOption(code: "en", name: "English (US)"),
        LanguageOption(code: "es", name: "Spanish (Español)"),
        LanguageOption(code: "pt", name: "Portuguese (Português)"),
        LanguageOption(code: "fr", name: "French (Français)"),
        LanguageOption(code: "ja", name: "Japanese (日本語)"),
        LanguageOption(code: "zh", name: "Mandarin (中文)")
    ]

    public let availableVoices: [String] = ["Aoede", "Puck", "Kore", "Charon", "Fenrir"]
    
    public func resetTranscripts() {
        self.speakerTranscript = ""
        self.translatedTranscript = ""
    }
}
