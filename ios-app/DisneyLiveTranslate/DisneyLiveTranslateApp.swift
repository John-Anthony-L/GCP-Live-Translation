import SwiftUI

@main
struct DisneyLiveTranslateApp: App {
    @StateObject private var session = TranslationSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(session)
        }
    }
}
