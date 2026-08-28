import SwiftUI

struct LiveInterpreterView: View {
    @EnvironmentObject var session: TranslationSession
    @State private var wsClient: LiveTranslationWebSocket?
    @State private var isHoldingMic = false

    var body: some View {
        NavigationView {
            ZStack {
                Color(red: 10/255, green: 17/255, blue: 40/255).ignoresSafeArea()

                VStack(spacing: 16) {
                    // Header Bar & Status
                    HStack {
                        VStack(alignment: .leading) {
                            Text("✨ Disney Live Translate")
                                .font(.title3)
                                .fontWeight(.bold)
                                .foregroundColor(.white)
                            Text("Gemini 2.0 Live API • Vertex AI")
                                .font(.caption2)
                                .foregroundColor(.yellow)
                        }
                        Spacer()
                        HStack(spacing: 6) {
                            Circle()
                                .fill(session.isConnected ? Color.green : Color.red)
                                .frame(width: 8, height: 8)
                            Text(session.isConnected ? "Connected" : "Offline")
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.black.opacity(0.3))
                        .cornerRadius(12)
                    }
                    .padding(.horizontal)

                    // Language Selector
                    HStack(spacing: 12) {
                        Picker("Source", selection: $session.sourceLanguage) {
                            ForEach(session.availableLanguages) { lang in
                                Text(lang.name).tag(lang.code)
                            }
                        }
                        .pickerStyle(MenuPickerStyle())
                        .padding(8)
                        .background(Color(red: 22/255, green: 38/255, blue: 77/255))
                        .cornerRadius(10)
                        .foregroundColor(.white)

                        Image(systemName: "arrow.left.arrow.right")
                            .foregroundColor(.yellow)

                        Picker("Target", selection: $session.targetLanguage) {
                            ForEach(session.availableLanguages) { lang in
                                Text(lang.name).tag(lang.code)
                            }
                        }
                        .pickerStyle(MenuPickerStyle())
                        .padding(8)
                        .background(Color(red: 22/255, green: 38/255, blue: 77/255))
                        .cornerRadius(10)
                        .foregroundColor(.white)
                    }
                    .padding(.horizontal)

                    // Performance HUD
                    HStack(spacing: 12) {
                        MetricCard(title: "LATENCY", value: "\(session.currentLatencyMs) ms", subtitle: "Speech-to-Speech")
                        MetricCard(title: "GLOSSARY", value: "Active", subtitle: "24 Park Terms")
                        MetricCard(title: "VOICE", value: session.voice, subtitle: "Prebuilt PCM")
                    }
                    .padding(.horizontal)

                    // Subtitles Container
                    VStack(spacing: 12) {
                        // Speaker Transcript Box
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("SPEAKER")
                                    .font(.caption2)
                                    .fontWeight(.bold)
                                    .foregroundColor(.blue)
                                Spacer()
                            }
                            Text(session.isStreaming ? "Listening in real time..." : "Press and hold microphone below to speak...")
                                .font(.body)
                                .foregroundColor(session.isStreaming ? .white : .gray)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding()
                        .frame(maxWidth: .infinity, minHeight: 90)
                        .background(Color(red: 22/255, green: 38/255, blue: 77/255).opacity(0.8))
                        .cornerRadius(14)

                        // Translated Output Box
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("TRANSLATION (INTERPRETER)")
                                    .font(.caption2)
                                    .fontWeight(.bold)
                                    .foregroundColor(.yellow)
                                Spacer()
                            }
                            Text(session.translatedTranscript.isEmpty ? "Live translation will appear here..." : session.translatedTranscript)
                                .font(.headline)
                                .foregroundColor(.white)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding()
                        .frame(maxWidth: .infinity, minHeight: 120)
                        .background(Color(red: 22/255, green: 38/255, blue: 77/255).opacity(0.8))
                        .cornerRadius(14)
                    }
                    .padding(.horizontal)

                    Spacer()

                    // Push-to-Talk Mic Action Button
                    VStack(spacing: 8) {
                        Button(action: {}) {
                            ZStack {
                                Circle()
                                    .fill(session.isStreaming ? Color.red : Color.yellow)
                                    .frame(width: 84, height: 84)
                                    .shadow(color: (session.isStreaming ? Color.red : Color.yellow).opacity(0.5), radius: 16)

                                Image(systemName: "mic.fill")
                                    .font(.system(size: 36))
                                    .foregroundColor(session.isStreaming ? .white : Color(red: 10/255, green: 17/255, blue: 40/255))
                            }
                        }
                        .simultaneousGesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { _ in
                                    if !isHoldingMic {
                                        isHoldingMic = true
                                        wsClient?.startLiveStreaming()
                                    }
                                }
                                .onEnded { _ in
                                    isHoldingMic = false
                                    wsClient?.stopLiveStreaming()
                                }
                        )

                        Text(isHoldingMic ? "Streaming Audio..." : "Hold to Speak (Simultaneous Translate)")
                            .font(.footnote)
                            .foregroundColor(.gray)
                    }
                    .padding(.bottom, 24)
                }
            }
            .navigationBarHidden(true)
            .onAppear {
                if wsClient == nil {
                    wsClient = LiveTranslationWebSocket(session: session)
                    wsClient?.connect()
                }
            }
        }
    }
}

struct MetricCard: View {
    let title: String
    let value: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 4) {
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(.gray)
            Text(value)
                .font(.system(size: 14, weight: .bold))
                .foregroundColor(.yellow)
            Text(subtitle)
                .font(.system(size: 9))
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(Color(red: 22/255, green: 38/255, blue: 77/255).opacity(0.6))
        .cornerRadius(10)
    }
}
