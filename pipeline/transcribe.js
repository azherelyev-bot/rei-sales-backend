const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');
const { log } = require('../utils/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Downloads a call recording from a URL and transcribes it using Whisper.
 * FollowUp Boss call recordings are stored as MP3/WAV URLs.
 *
 * @param {string} recordingUrl - Direct URL to the audio file
 * @param {object} opts
 * @param {string} opts.repName - Name of the rep (helps Whisper with speaker hints)
 * @param {string} opts.leadName - Name of the lead
 * @returns {Promise<{transcript: string, durationSeconds: number}>}
 */
async function transcribeCall(recordingUrl, { repName = 'Rep', leadName = 'Lead' } = {}) {
  log('info', `Transcribing call: ${recordingUrl}`);

  // 1. Download the audio file
  const audioResponse = await axios.get(recordingUrl, {
    responseType: 'arraybuffer',
    // FUB recordings may require auth — add API key header if needed
    headers: {
      Authorization: `Basic ${Buffer.from(process.env.FUB_API_KEY + ':').toString('base64')}`
    }
  });

  const audioBuffer = Buffer.from(audioResponse.data);
  const contentType = audioResponse.headers['content-type'] || 'audio/mpeg';
  const ext = contentType.includes('wav') ? 'wav' : 'mp3';

  // 2. Build form data for Whisper
  const form = new FormData();
  form.append('file', audioBuffer, {
    filename: `call.${ext}`,
    contentType
  });
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  // Prompt helps Whisper understand the context (real estate sales calls)
  form.append(
    'prompt',
    `This is a real estate sales call between ${repName} (sales rep) and ${leadName} (homeowner lead). ` +
    `Topics include: selling their home, off-market deals, cash offers, motivated sellers, as-is condition, equity, timeline, price.`
  );
  form.append('response_format', 'verbose_json'); // gives us duration + segments

  // 3. Send to Whisper
  const whisperResponse = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  const { text: transcript, duration } = whisperResponse.data;

  log('info', `Transcription complete. Duration: ${Math.round(duration)}s, Words: ${transcript.split(' ').length}`);

  return {
    transcript,
    durationSeconds: Math.round(duration || 0)
  };
}

module.exports = { transcribeCall };
