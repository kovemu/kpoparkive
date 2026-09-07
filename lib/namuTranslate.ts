import type { ParsedSection } from "./namuParser";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export type TranslatedDocument = {
  title: string;
  sections: ParsedSection[];
};

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced || text).trim();
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) throw new Error("Translator did not return JSON");
  return candidate.slice(first, last + 1);
}

function normalizeSections(input: unknown, fallback: ParsedSection[]): ParsedSection[] {
  if (!Array.isArray(input)) return fallback;
  return input.map((section, index) => {
    const source = fallback[index];
    const value = section as Partial<ParsedSection>;
    return {
      section_key: source?.section_key || value.section_key || `section-${index + 1}`,
      heading: String(value.heading || source?.heading || `Section ${index + 1}`),
      heading_level: Number(source?.heading_level || value.heading_level || 2),
      sort_order: Number(source?.sort_order || value.sort_order || (index + 1) * 10),
      content: Array.isArray(value.content) ? value.content as ParsedSection["content"] : source?.content || [],
    };
  });
}

export async function translateNamuDocument(sourceTitle: string, sections: ParsedSection[]): Promise<TranslatedDocument> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

  const prompt = `You are localizing a Korean K-pop encyclopedia document for English-speaking fans.\n\nTranslate the supplied document into natural, concise English while preserving the complete factual meaning and structure. Do not summarize or omit details. Preserve idol/group/stage names, song titles, album titles, brands, dates, numbers, URLs, and fandom-specific proper nouns unless there is a well-established English form. Do not invent facts. Keep section_key, heading_level, sort_order, block type, table dimensions, and related-document targets structurally intact. Translate Korean prose, headings, table labels/cells, list items, related labels and targets when an obvious English rendering exists.\n\nReturn ONLY valid JSON matching this exact shape:\n{\n  "title": "English title",\n  "sections": [\n    {\n      "section_key": "unchanged-key",\n      "heading": "English heading",\n      "heading_level": 2,\n      "sort_order": 10,\n      "content": []\n    }\n  ]\n}\n\nSource title: ${sourceTitle}\nSource sections:\n${JSON.stringify(sections)}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.15,
          responseMimeType: "application/json",
        },
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) throw new Error(`Gemini translation failed ${response.status}: ${await response.text()}`);
  const payload = await response.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  const parsed = JSON.parse(extractJson(text)) as { title?: string; sections?: unknown };

  return {
    title: String(parsed.title || sourceTitle),
    sections: normalizeSections(parsed.sections, sections),
  };
}
