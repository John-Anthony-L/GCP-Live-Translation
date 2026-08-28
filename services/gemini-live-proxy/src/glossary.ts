import * as fs from 'fs';
import * as path from 'path';

export interface GlossaryTerm {
  term_id: string;
  en: string;
  category: string;
  keep_original: boolean;
  phonetic_en?: string;
  translations: Record<string, string>;
  notes?: string;
}

export interface GlossaryData {
  version: string;
  name: string;
  brand_rules: string[];
  terms: GlossaryTerm[];
}

let cachedGlossary: GlossaryData | null = null;

export function loadGlossary(): GlossaryData {
  if (cachedGlossary) {
    return cachedGlossary;
  }

  // Attempt to load from multiple potential locations
  const potentialPaths = [
    path.resolve(process.cwd(), 'glossaries/disney_parks_glossary.json'),
    path.resolve(__dirname, '../../../glossaries/disney_parks_glossary.json'),
    path.resolve(__dirname, '../glossaries/disney_parks_glossary.json'),
    path.resolve(__dirname, './disney_parks_glossary.json')
  ];

  for (const p of potentialPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      cachedGlossary = JSON.parse(raw) as GlossaryData;
      return cachedGlossary;
    }
  }

  // Fallback default if file not found
  cachedGlossary = {
    version: '1.0',
    name: 'Disney Parks Live Translation (Default Fallback)',
    brand_rules: [
      "Keep attraction and brand names in English (e.g., 'Lightning Lane', 'MagicBand+', 'Space Mountain', 'Rise of the Resistance').",
      "Translate Cast Member respectfully ('Miembro del Elenco' in Spanish).",
      "Maintain a polite, helpful, magical Disney service tone."
    ],
    terms: []
  };
  return cachedGlossary;
}

export function buildSystemInstruction(
  sourceLang: string = 'en',
  targetLang: string = 'es',
  mode: 'interpreter' | 'cast_member' | 'guest' = 'interpreter'
): string {
  const glossary = loadGlossary();
  const targetCode = targetLang.toLowerCase().slice(0, 2);

  const termRules = glossary.terms
    .map(t => {
      const targetTrans = t.translations[targetCode] || (t.keep_original ? t.en : t.en);
      if (t.keep_original) {
        return `- "${t.en}" [${t.category}]: DO NOT translate. Always pronounce/keep as "${t.en}".`;
      } else {
        return `- "${t.en}" [${t.category}]: Translate strictly as "${targetTrans}". (${t.notes || ''})`;
      }
    })
    .join('\n');

  const brandRulesText = glossary.brand_rules.map((r, i) => `${i + 1}. ${r}`).join('\n');

  const languageMap: Record<string, string> = {
    en: 'English',
    es: 'Spanish (Latin America / Neutral)',
    pt: 'Portuguese (Brazil)',
    fr: 'French',
    ja: 'Japanese',
    zh: 'Mandarin Chinese',
    de: 'German',
    it: 'Italian'
  };

  const srcName = languageMap[sourceLang.toLowerCase().slice(0, 2)] || sourceLang;
  const tgtName = languageMap[targetCode] || targetLang;

  return `You are a real-time bilingual simultaneous live interpreter for Walt Disney World & Disneyland Parks, assisting Disney Cast Members and International Guests.

LANGUAGE PAIR: ${srcName} <---> ${tgtName}

PRIMARY TASK:
- Translate spoken dialogue immediately and naturally between ${srcName} and ${tgtName}.
- If you hear ${srcName}, translate it directly into ${tgtName}.
- If you hear ${tgtName}, translate it directly into ${srcName}.
- Deliver ONLY the direct translation in natural spoken audio.
- DO NOT add conversational filler, meta-announcements, intros (e.g. "The guest says..."), or your own conversational responses.

DISNEY BRAND TONE & PERSONALITY:
- Warm, polite, hospitable, and magical—reflecting Disney's world-class guest service.
- Maintain the original speaker's emotional inflection, urgency, and enthusiasm.

DISNEY PARKS GLOSSARY & VOCABULARY ENFORCEMENT:
${brandRulesText}

SPECIFIC VOCABULARY MAPPINGS:
${termRules}

CRITICAL RULES:
- Never break character or explain translation rules.
- If audio is unclear or partial, translate what was heard without commentary.`;
}
