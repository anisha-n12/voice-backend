
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED_ACTIONS = [
  "SELECT_BANK",
  "SEARCH_BANK",
  "GO_BACK",
  "REPEAT_INSTRUCTIONS",
  "CONTINUE",
  "CANCEL",
  "HELP",
  "UNKNOWN",
] as const;

type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

type GeminiIntent = {
  action: AllowedAction;
  bank: string;
  searchQuery: string;
  speech: string;
  needsConfirmation: boolean;
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function fallbackResponse(language: "hi" | "en"): GeminiIntent {
  return {
    action: "UNKNOWN",
    bank: "",
    searchQuery: "",
    speech:
      language === "hi"
        ? "माफ़ कीजिए, मैं समझ नहीं पाया। कृपया फिर से बोलिए।"
        : "Sorry, I didn't understand. Please say that again.",
    needsConfirmation: false,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("GEMINI_API_KEY is not configured");

    return res.status(500).json({
      error: "Gemini API is not configured",
    });
  }

  const body = req.body ?? {};

  const transcript = body.transcript;
  const language = body.language === "hi" ? "hi" : "en";
  const screen =
    typeof body.screen === "string" &&
    body.screen.length > 0 &&
    body.screen.length <= 100
      ? body.screen
      : "bank_selection";

  const rawBanks = body.availableBanks;
  const selectedBank =
    typeof body.selectedBank === "string"
      ? body.selectedBank
      : "";

  if (
    typeof transcript !== "string" ||
    transcript.trim().length === 0 ||
    transcript.length > 1000
  ) {
    return res.status(400).json({
      error: "transcript must be a non-empty string of at most 1000 characters",
    });
  }

  if (
    !Array.isArray(rawBanks) ||
    rawBanks.length > 100 ||
    !rawBanks.every(
      (bank: unknown) =>
        typeof bank === "string" &&
        bank.trim().length > 0 &&
        bank.length <= 100
    )
  ) {
    return res.status(400).json({
      error: "availableBanks must be an array of bank-name strings",
    });
  }

  const availableBanks = rawBanks as string[];

  const systemInstruction = `
You are the intent-classification and voice-navigation assistant
for Voice UPI, an accessibility-first Android prototype.

The user's preferred response language is ${
    language === "hi" ? "Hindi" : "English"
}.
The current screen is: ${screen}.
Available bank names are: ${JSON.stringify(availableBanks)}.
Currently selected bank: ${JSON.stringify(selectedBank || "")}.

The user may speak Hindi, English, Hinglish, or Hindi written in Latin
letters. Speech recognition may contain minor errors. Interpret the
transcript in the context of the current screen.

Return only JSON matching the provided schema.

Action definitions:
- SELECT_BANK: the user clearly asks to select one available bank.
- SEARCH_BANK: the user asks to find or search for a bank.
- GO_BACK: the user asks to return to the previous screen.
- REPEAT_INSTRUCTIONS: the user asks you to repeat instructions.
- CONTINUE: the user clearly asks to continue to the next step.
- CANCEL: the user asks to cancel the current operation.
- HELP: the user asks for help or an explanation.
- UNKNOWN: the intent is unclear or unsupported.

Rules:
1. For SELECT_BANK, bank must exactly match one entry in availableBanks.
2. Never invent a bank or return a bank name not in availableBanks.
3. If a bank is mentioned but the intent is to search for it, use SEARCH_BANK.
4. If the user says continue on the bank-selection screen without a
   selected bank, use UNKNOWN and ask them to select a bank.
5. Recognize "peeche jao", "वापस जाओ", "back", and equivalent phrases
   as GO_BACK.
6. Recognize "dobara batao", "फिर से बताइए", "repeat", and equivalents
   as REPEAT_INSTRUCTIONS.
7. Keep speech short, clear, respectful, and in the preferred language.
8. Do not claim that a bank account was linked, verified, or activated.
9. Never ask for or infer OTPs, Aadhaar numbers, debit-card numbers,
   or UPI PINs.
10. Do not initiate payments or claim that any transaction occurred.
11. Set needsConfirmation to true when the user needs to confirm a
    consequential selection or action. For unclear commands, use false.
12. For actions other than SELECT_BANK, return an empty bank string
    unless a bank name is useful for SEARCH_BANK.
13. Return empty strings instead of null for unused bank and searchQuery.
`;

  try {
    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: transcript.trim() }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                action: {
                  type: "STRING",
                  enum: [...ALLOWED_ACTIONS],
                },
                bank: {
                  type: "STRING",
                },
                searchQuery: {
                  type: "STRING",
                },
                speech: {
                  type: "STRING",
                },
                needsConfirmation: {
                  type: "BOOLEAN",
                },
              },
              required: [
                "action",
                "bank",
                "searchQuery",
                "speech",
                "needsConfirmation",
              ],
            },
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const details = await geminiResponse.text();

      console.error(
        "Gemini request failed:",
        geminiResponse.status,
        details
      );

      return res.status(502).json({
        error: "Gemini could not interpret the voice command",
      });
    }

    const geminiData = await geminiResponse.json();

    const output = geminiData.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text ?? "")
      .join("")
      .trim();

    if (!output) {
      console.error("Gemini returned no text");
      return res.status(502).json({
        error: "Empty Gemini response",
      });
    }

    let parsed: Partial<GeminiIntent>;

    try {
      parsed = JSON.parse(output) as Partial<GeminiIntent>;
    } catch {
      console.error("Gemini returned invalid JSON");
      return res.status(502).json({
        error: "Invalid JSON returned by Gemini",
      });
    }

    if (
      typeof parsed.action !== "string" ||
      !ALLOWED_ACTIONS.includes(parsed.action as AllowedAction) ||
      typeof parsed.bank !== "string" ||
      typeof parsed.searchQuery !== "string" ||
      typeof parsed.speech !== "string" ||
      typeof parsed.needsConfirmation !== "boolean"
    ) {
      console.error("Gemini returned an invalid intent structure");
      return res.status(502).json({
        error: "Gemini returned an invalid intent structure",
      });
    }

    const intent = parsed as GeminiIntent;

    // Validate bank names against the list supplied by Android.
    if (intent.action === "SELECT_BANK") {
      const matchedBank = availableBanks.find(
        (bank) => normalize(bank) === normalize(intent.bank)
      );

      if (!matchedBank) {
        return res.status(200).json(
          fallbackResponse(language)
        );
      }

      // Return the canonical bank name from the Android-provided list.
      intent.bank = matchedBank;
      intent.searchQuery = "";
    } else {
      intent.bank = "";
    }

    // Prevent excessively long speech or search strings.
    intent.speech = intent.speech.trim().slice(0, 300);
    intent.searchQuery = intent.searchQuery.trim().slice(0, 100);

    if (!intent.speech) {
      intent.speech = fallbackResponse(language).speech;
    }

    // Never trust Gemini to perform an action. Android must validate it.
    return res.status(200).json(intent);
  } catch (error) {
    console.error("Intent interpretation error:", error);

    return res.status(502).json({
      error: "Voice interpretation failed",
    });
  }
}
