import Foundation

public struct GlossaryTerm: Identifiable, Codable {
    public var id: String { termId }
    public let termId: String
    public let en: String
    public let category: String
    public let keepOriginal: Bool
    public let phoneticEn: String?
    public let translations: [String: String]
    public let notes: String?

    enum CodingKeys: String, CodingKey {
        case termId = "term_id"
        case en
        case category
        case keepOriginal = "keep_original"
        case phoneticEn = "phonetic_en"
        case translations
        case notes
    }
}

public struct DisneyGlossaryData: Codable {
    public let version: String
    public let name: String
    public let brandRules: [String]
    public let terms: [GlossaryTerm]

    enum CodingKeys: String, CodingKey {
        case version
        case name
        case brandRules = "brand_rules"
        case terms
    }
}

public class DisneyGlossaryStore: ObservableObject {
    @Published public var terms: [GlossaryTerm] = []
    @Published public var brandRules: [String] = []

    public init() {
        loadDefaultGlossary()
    }

    private func loadDefaultGlossary() {
        self.brandRules = [
            "Keep attraction and brand names in English (e.g., 'Lightning Lane', 'MagicBand+', 'Space Mountain').",
            "Translate Cast Member respectfully ('Miembro del Elenco' in Spanish).",
            "Maintain a polite, cheerful, magical Disney service tone."
        ]

        self.terms = [
            GlossaryTerm(termId: "lightning_lane", en: "Lightning Lane", category: "Service", keepOriginal: true, phoneticEn: "LAHYT-ning layn", translations: ["es": "Lightning Lane", "pt": "Lightning Lane", "fr": "Lightning Lane", "ja": "ライトニング・レーン"], notes: "Disney express queue service."),
            GlossaryTerm(termId: "magicband_plus", en: "MagicBand+", category: "Merchandise", keepOriginal: true, phoneticEn: "MAJ-ik band pluhs", translations: ["es": "MagicBand+", "pt": "MagicBand+", "fr": "MagicBand+"], notes: "Wearable RFID device."),
            GlossaryTerm(termId: "cast_member", en: "Cast Member", category: "Personnel", keepOriginal: false, phoneticEn: nil, translations: ["es": "Miembro del Elenco", "pt": "Membro do Elenco", "fr": "Cast Member"], notes: "Disney employee."),
            GlossaryTerm(termId: "rope_drop", en: "Rope Drop", category: "Concept", keepOriginal: false, phoneticEn: nil, translations: ["es": "Apertura del parque", "pt": "Abertura dos portões"], notes: "Arriving at park opening time."),
            GlossaryTerm(termId: "space_mountain", en: "Space Mountain", category: "Attraction", keepOriginal: true, phoneticEn: nil, translations: ["es": "Space Mountain", "ja": "スペース・マウンテン"], notes: "Indoor coaster."),
            GlossaryTerm(termId: "rise_of_the_resistance", en: "Star Wars: Rise of the Resistance", category: "Attraction", keepOriginal: true, phoneticEn: nil, translations: ["es": "Star Wars: Rise of the Resistance"], notes: "Galaxy's Edge dark ride."),
            GlossaryTerm(termId: "haunted_mansion", en: "Haunted Mansion", category: "Attraction", keepOriginal: true, phoneticEn: nil, translations: ["es": "Haunted Mansion"], notes: "Liberty Square ride.")
        ]
    }
}
