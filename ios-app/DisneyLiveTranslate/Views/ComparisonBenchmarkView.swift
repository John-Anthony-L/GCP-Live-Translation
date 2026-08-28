import SwiftUI

struct ComparisonBenchmarkView: View {
    var body: some View {
        NavigationView {
            ZStack {
                Color(red: 10/255, green: 17/255, blue: 40/255).ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("🏰 Architecture Evaluation Matrix")
                            .font(.title2)
                            .fontWeight(.bold)
                            .foregroundColor(.white)

                        Text("Comparative assessment across Google Cloud technologies for Disney Parks live translation on iOS.")
                            .font(.subheadline)
                            .foregroundColor(.gray)

                        // 1. Gemini Live API Card
                        EngineEvalCard(
                            title: "Gemini 2.0 Live API (Vertex AI)",
                            badge: "RECOMMENDED",
                            badgeColor: .yellow,
                            latency: "400ms – 800ms",
                            glossaryMode: "Prompt-injected Disney glossary & phonetics",
                            strengths: "Real-time speech-to-speech, natural Disney service tone, low latency, single WebSocket.",
                            drawbacks: "Soft glossary adherence (probabilistic vs deterministic lock)."
                        )

                        // 2. Translation API Advanced Card
                        EngineEvalCard(
                            title: "Translation API Advanced v3 Pipeline",
                            badge: "DETERMINISTIC",
                            badgeColor: .blue,
                            latency: "950ms – 1,800ms",
                            glossaryMode: "100% Deterministic Cloud Glossary (GCS CSV/TSV)",
                            strengths: "Guaranteed brand vocabulary matching, formal/informal control, proven production stability.",
                            drawbacks: "High latency from 3-hop pipeline (STT ➔ MT ➔ TTS), synthetic sounding voices."
                        )

                        // 3. CX Agent Studio Card
                        EngineEvalCard(
                            title: "CX Agent Studio (CXAS)",
                            badge: "CONVERSATIONAL",
                            badgeColor: .purple,
                            latency: "1,500ms – 3,500ms",
                            glossaryMode: "Vertex AI Search RAG Data Stores & Playbooks",
                            strengths: "Ideal for Virtual Concierge bots that execute actions (wait times, dining bookings).",
                            drawbacks: "Over-engineered for pure translation; intent & playbook reasoning adds significant latency."
                        )
                    }
                    .padding()
                }
            }
            .navigationBarHidden(true)
        }
    }
}

struct EngineEvalCard: View {
    let title: String
    let badge: String
    let badgeColor: Color
    let latency: String
    let glossaryMode: String
    let strengths: String
    let drawbacks: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title)
                    .font(.headline)
                    .foregroundColor(.white)
                Spacer()
                Text(badge)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(badgeColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(badgeColor.opacity(0.15))
                    .cornerRadius(8)
            }

            Divider().background(Color.gray.opacity(0.3))

            HStack {
                Text("End-to-End Latency:")
                    .font(.caption)
                    .foregroundColor(.gray)
                Text(latency)
                    .font(.caption)
                    .fontWeight(.bold)
                    .foregroundColor(.yellow)
            }

            HStack {
                Text("Glossary Handling:")
                    .font(.caption)
                    .foregroundColor(.gray)
                Text(glossaryMode)
                    .font(.caption)
                    .foregroundColor(.white)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("PROS:").font(.system(size: 9, weight: .bold)).foregroundColor(.green)
                Text(strengths).font(.caption2).foregroundColor(.gray)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("LIMITATIONS:").font(.system(size: 9, weight: .bold)).foregroundColor(.red)
                Text(drawbacks).font(.caption2).foregroundColor(.gray)
            }
        }
        .padding()
        .background(Color(red: 22/255, green: 38/255, blue: 77/255).opacity(0.7))
        .cornerRadius(14)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.white.opacity(0.1), lineWidth: 1)
        )
    }
}
