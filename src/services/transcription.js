/**
 * Transcription Service — OpenAI Whisper
 * 
 * Downloads the call recording from FollowUp Boss,
 * sends it to Whisper API, returns the full transcript text.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import FormData from 'form-data';
import axios from 'axios';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeCall(recordingUrl, callId) {
  const tmpPath = path.join(os.tmpdir(), `call-${callId}.mp3`);

  try {
    // 1. Download audio file from FUB recording URL
    console.log(`[TRANSCRIBE] Downloading recording from FUB...`);
    const response = await axios({
      method: 'GET',
      url: recordingUrl,
      responseType: 'stream',
      headers: {
        // FUB recordings may require API auth
        Authorization: `Basic ${Buffer.from(process.env.FUB_API_KEY + ':').toString('base64')}`
      },
      timeout: 60000
    });

    // Stream to temp file
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tmpPath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // 2. Send to Whisper for transcription
    console.log(`[TRANSCRIBE] Sending to Whisper...`);
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'en',
      response_format: 'text'
    });

    return transcription;
  } finally {
    // Always clean up temp file
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  }
}
