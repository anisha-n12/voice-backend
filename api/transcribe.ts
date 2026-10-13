
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
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.SARVAM_API_KEY;

  if (!apiKey) {
    console.error("SARVAM_API_KEY is not configured");
    return res.status(500).json({
      error: "Sarvam API is not configured",
    });
  }

  let uploadedFilePath: string | undefined;

  try {
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 1,
      keepExtensions: true,
      allowEmptyFiles: false,
    });

    const [, files] = await form.parse(req);

    const uploadedFile = Array.isArray(files.file)
      ? files.file[0]
      : files.file;

    if (!uploadedFile) {
      return res.status(400).json({
        error: "No audio file received. Use multipart field name 'file'.",
      });
    }

    uploadedFilePath = uploadedFile.filepath;

    if (uploadedFile.size === 0) {
      return res.status(400).json({
        error: "The uploaded audio file is empty",
      });
    }

    const audioBuffer = await fs.readFile(uploadedFile.filepath);

    const sarvamForm = new FormData();

    // Convert Node Buffer to a Blob-compatible byte array.
    const audioBytes = new Uint8Array(audioBuffer);

    const audioBlob = new Blob([audioBytes], {
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

    const sarvamResponse = await fetch(
      "https://api.sarvam.ai/speech-to-text",
      {
        method: "POST",
        headers: {
          "api-subscription-key": apiKey,
        },
        body: sarvamForm,
      }
    );

    if (!sarvamResponse.ok) {
      const details = await sarvamResponse.text();

      console.error(
        "Sarvam request failed:",
        sarvamResponse.status,
        details
      );

      return res.status(502).json({
        error: "Sarvam transcription failed",
        upstreamStatus: sarvamResponse.status,
      });
    }

    const sarvamData = await sarvamResponse.json();

    const transcript =
      typeof sarvamData.transcript === "string"
        ? sarvamData.transcript.trim()
        : "";

    if (!transcript) {
      return res.status(422).json({
        error: "No speech detected. Please try speaking again.",
        language_code: sarvamData.language_code ?? null,
        request_id: sarvamData.request_id ?? null,
      });
    }

    return res.status(200).json({
      transcript,
      language_code: sarvamData.language_code ?? null,
      request_id: sarvamData.request_id ?? null,
    });
  } catch (error) {
    console.error("Transcription error:", error);

    return res.status(500).json({
      error: "Internal server error during transcription",
    });
  } finally {
    if (uploadedFilePath) {
      try {
        await fs.unlink(uploadedFilePath);
      } catch (cleanupError) {
        console.error(
          "Temporary audio cleanup failed:",
          cleanupError
        );
      }
    }
  }
}
