import SwiftUI

struct ContentView: View {
    @EnvironmentObject var session: TranslationSession

    var body: some View {
        TabView {
            LiveInterpreterView()
                .tabItem {
                    Label("Interpreter", systemImage: "waveform.and.mic")
                }

            ComparisonBenchmarkView()
                .tabItem {
                    Label("Compare", systemImage: "chart.bar.xaxis")
                }

            GlossaryListView()
                .tabItem {
                    Label("Glossary", systemImage: "character.book.closed.fill")
                }
        }
        .accentColor(Color.yellow)
        .preferredColorScheme(.dark)
    }
}
