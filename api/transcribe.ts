import type { VercelRequest, VercelResponse } from "@vercel/node";
import formidable from "formidable";
import fs from "fs/promises";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  if (!process.env.SARVAM_API_KEY) {
    return res.status(500).json({
      error: "SARVAM_API_KEY is not configured",
    });
  }

  try {
    // Parse uploaded audio
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024, // 10 MB
      keepExtensions: true,
    });

    const [, files] = await form.parse(req);

    const uploadedFile = Array.isArray(files.file)
      ? files.file[0]
      : files.file;

    if (!uploadedFile) {
      return res.status(400).json({
        error: "No audio file received. Use field name 'file'.",
      });
    }

    // Read audio file
    const audioBuffer = await fs.readFile(uploadedFile.filepath);

    // Create multipart request for Sarvam
    const sarvamForm = new FormData();

    const audioBlob = new Blob([audioBuffer], {
      type: uploadedFile.mimetype || "audio/wav",
    });

    sarvamForm.append(
      "file",
      audioBlob,
      uploadedFile.originalFilename || "audio.wav"
    );

    sarvamForm.append("model", "saaras:v3");
    sarvamForm.append("mode", "transcribe");
    sarvamForm.append("language_code", "unknown");

    // Send audio to Sarvam
    const sarvamResponse = await fetch(
      "https://api.sarvam.ai/speech-to-text",
      {
        method: "POST",
        headers: {
          "api-subscription-key": process.env.SARVAM_API_KEY,
        },
        body: sarvamForm,
      }
    );

    const sarvamData = await sarvamResponse.json();

    if (!sarvamResponse.ok) {
      console.error("Sarvam error:", sarvamData);

      return res.status(sarvamResponse.status).json({
        error: "Sarvam transcription failed",
        details: sarvamData,
      });
    }

    return res.status(200).json({
      transcript: sarvamData.transcript,
      language_code: sarvamData.language_code,
      request_id: sarvamData.request_id,
    });

  } catch (error) {
    console.error("Transcription error:", error);

    return res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}