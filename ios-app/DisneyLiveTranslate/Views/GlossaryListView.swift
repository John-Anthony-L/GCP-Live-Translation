import SwiftUI

struct GlossaryListView: View {
    @StateObject private var glossaryStore = DisneyGlossaryStore()
    @State private var searchText = ""

    var filteredTerms: [GlossaryTerm] {
        if searchText.isEmpty {
            return glossaryStore.terms
        }
        return glossaryStore.terms.filter {
            $0.en.localizedCaseInsensitiveContains(searchText) ||
            $0.category.localizedCaseInsensitiveContains(searchText) ||
            ($0.translations.values.contains { $0.localizedCaseInsensitiveContains(searchText) })
        }
    }

    var body: some View {
        NavigationView {
            ZStack {
                Color(red: 10/255, green: 17/255, blue: 40/255).ignoresSafeArea()

                VStack(alignment: .leading, spacing: 16) {
                    Text("📖 Disney Parks Glossary")
                        .font(.title2)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                        .padding(.horizontal)

                    // Search bar
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundColor(.gray)
                        TextField("Search attractions, characters, services...", text: $searchText)
                            .foregroundColor(.white)
                    }
                    .padding(10)
                    .background(Color(red: 22/255, green: 38/255, blue: 77/255))
                    .cornerRadius(10)
                    .padding(.horizontal)

                    List(filteredTerms) { term in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(term.en)
                                    .font(.headline)
                                    .foregroundColor(.white)
                                Spacer()
                                Text(term.category)
                                    .font(.caption2)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.blue.opacity(0.3))
                                    .cornerRadius(6)
                                    .foregroundColor(.cyan)
                            }

                            if let es = term.translations["es"] {
                                Text("➔ Spanish: \(es)")
                                    .font(.subheadline)
                                    .foregroundColor(.yellow)
                            }

                            if let notes = term.notes {
                                Text(notes)
                                    .font(.caption2)
                                    .foregroundColor(.gray)
                            }

                            if term.keepOriginal {
                                HStack(spacing: 4) {
                                    Image(systemName: "lock.fill").font(.system(size: 8))
                                    Text("Brand Rule: Do NOT translate")
                                }
                                .font(.system(size: 10))
                                .foregroundColor(.green)
                            }
                        }
                        .padding(.vertical, 4)
                        .listRowBackground(Color(red: 16/255, green: 31/255, blue: 66/255))
                    }
                    .listStyle(PlainListStyle())
                }
            }
            .navigationBarHidden(true)
        }
    }
}
