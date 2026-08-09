const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PYTHON_BIN = path.join(__dirname, '..', 'tts_env', 'bin', 'python3');
const WORKER_SCRIPT = path.join(__dirname, 'musicgen_worker.py');

// MusicGen-small was trained on ~30s clips - generation quality falls off
// badly past that, so requests longer than this just get the clip looped
// afterward (see video.js's muxLoopedAudio) instead of generating longer.
const MAX_GENERATE_SECONDS = 30;

// Runs lib/musicgen_worker.py in tts_env (where torch/transformers already
// live for this project's TTS feature) to synthesize a WAV file matching
// `prompt`, capped at MAX_GENERATE_SECONDS regardless of the requested
// duration.
async function generateMusic({ prompt, duration, outPath }) {
  const clamped = Math.min(Math.max(duration, 1), MAX_GENERATE_SECONDS);
  const args = JSON.stringify({ prompt, duration: clamped, outPath });
  try {
    await execFileAsync(PYTHON_BIN, [WORKER_SCRIPT, args], { maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-5).join('\n');
    throw new Error(`배경음악 생성 실패: ${detail}`);
  }
}

module.exports = { generateMusic, MAX_GENERATE_SECONDS };
