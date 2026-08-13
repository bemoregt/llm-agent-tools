const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|aac|flac)$/i;
const PDF_EXT = /\.pdf$/i;
const DOCX_EXT = /\.docx$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i;
const PY_EXT = /\.py$/i;
// Matches the same video extensions lib/wiki.js's inline() already renders
// as <video controls> - anything else (like a raw .avi) wouldn't show as a
// playable attachment on the page in the first place.
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;

// Scans the page's raw markdown for `[label](/uploads/xxx)` /
// `![alt](/uploads/xxx)` links and returns the ones that exist on disk.
function findUploadRefs(body, uploadDir) {
  const re = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  const files = [];
  let m;
  while ((m = re.exec(body))) {
    const match = m[1].trim().match(/^\/uploads\/(.+)$/);
    if (!match) continue;
    const filename = decodeURIComponent(match[1]);
    const abs = path.join(uploadDir, filename);
    if (fs.existsSync(abs)) files.push({ filename, abs });
  }
  return files;
}

function findAudioAndPdf(body, uploadDir) {
  const files = findUploadRefs(body, uploadDir);
  return {
    audio: files.find((f) => AUDIO_EXT.test(f.filename)),
    pdf: files.find((f) => PDF_EXT.test(f.filename)),
  };
}

// Just the PDF half of findAudioAndPdf, for features (like the paper
// summarizer) that don't need an audio track at all.
function findPdf(body, uploadDir) {
  return findUploadRefs(body, uploadDir).find((f) => PDF_EXT.test(f.filename));
}

// First uploaded .docx referenced on the page, for the "이력서 최적화하기"
// feature's input resume.
function findDocx(body, uploadDir) {
  return findUploadRefs(body, uploadDir).find((f) => DOCX_EXT.test(f.filename));
}

// First uploaded .py file referenced on the page, for the "주피터 노트북으로
// 변경" feature's fallback source (its primary source is a ```python fenced
// code block already in the page body - see server.js's extractPythonCode).
function findPy(body, uploadDir) {
  return findUploadRefs(body, uploadDir).find((f) => PY_EXT.test(f.filename));
}

// First uploaded image referenced on the page (via either ![alt](url) or
// [label](url) - findUploadRefs doesn't care which), for the "코드로
// 테스트하기" feature's input image.
function findImage(body, uploadDir) {
  return findUploadRefs(body, uploadDir).find((f) => IMAGE_EXT.test(f.filename));
}

// First uploaded audio file referenced on the page, for the "코드로
// 테스트하기" feature's input audio (as opposed to findAudioAndPdf, which
// only cares about audio when it's paired with a PDF for slideshow videos).
function findAudio(body, uploadDir) {
  return findUploadRefs(body, uploadDir).find((f) => AUDIO_EXT.test(f.filename));
}

// Generated code shouldn't have to handle every audio format a user might
// upload (mp3/ogg/m4a/...) - this normalizes whatever was attached into a
// plain 16-bit PCM WAV first, so process_audio() can always rely on
// scipy.io.wavfile.read() working no matter what the original file was.
async function convertToWav(inputPath, outputPath) {
  await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-c:a', 'pcm_s16le', outputPath]);
}

// First uploaded video file referenced on the page, for the "코드로
// 테스트하기" feature's input video (process_video). Unlike audio, this is
// handed to generated code as-is - cv2.VideoCapture wraps ffmpeg internally
// and already tolerates whatever container/codec was uploaded, so there's
// nothing to normalize on the way in.
function findVideo(body, uploadDir) {
  return findUploadRefs(body, uploadDir).find((f) => VIDEO_EXT.test(f.filename));
}

// The reverse problem shows up on the way OUT: a generated process_video()
// writes its result through cv2.VideoWriter, whose fourcc/container support
// is inconsistent across OpenCV builds and often isn't anything a browser
// can actually play. Re-encoding to plain H.264 MP4 here - the same fix
// applied to every other video this app produces (make-video/make-shorts) -
// means the model never has to get codec choice right for its output to
// actually show up as a playable <video> on the page.
async function reencodeToMp4(inputPath, outputPath) {
  await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', outputPath]);
}

// True if the media file (video or audio) has at least one audio stream -
// used by "배경음악 넣기" to confirm an uploaded video is actually silent
// before generating and muxing in a new track.
async function hasAudioStream(mediaPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    mediaPath,
  ]);
  return stdout.trim().length > 0;
}

// Muxes an audio track into a video by looping the audio indefinitely and
// trimming to the video's own length - used by "배경음악 넣기" to fill a
// video with a <=30s MusicGen clip (see lib/musicgen.js) regardless of how
// long the video actually is. The video stream is copied untouched; the
// audio is re-encoded to AAC since a raw looped WAV isn't a valid mp4 audio
// codec.
async function muxLoopedAudio({ videoPath, audioPath, outPath }) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-stream_loop', '-1', '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
    outPath,
  ]);
}

// Also doubles as a generic media-duration reader (ffprobe's format=duration
// is container-level, not audio-specific) - "배경음악 넣기" uses it on video
// files to size the generated music clip.
async function getAudioDuration(audioPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('오디오 길이를 읽지 못했습니다.');
  return seconds;
}

async function pdfToImages(pdfPath, outDir) {
  await execFileAsync('pdftoppm', ['-png', '-r', '150', pdfPath, path.join(outDir, 'slide')]);
  return fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => path.join(outDir, f));
}

async function pdfText(pdfPath, maxChars = 4000) {
  const { stdout } = await execFileAsync('pdftotext', [pdfPath, '-']);
  return stdout.trim().slice(0, maxChars);
}

// Extracts a .docx's content as markdown (via pandoc) rather than plain text
// - unlike pdfText, this is meant to be fed back into markdownToDocx after
// an LLM edits it, so keeping headings/bullet structure intact (instead of
// flattening to plain text) matters for the round trip to still look like a
// real resume afterward.
async function docxToMarkdown(docxPath, maxChars = 8000) {
  const { stdout } = await execFileAsync('pandoc', [docxPath, '-t', 'markdown']);
  return stdout.trim().slice(0, maxChars);
}

// Renders markdown back into a real .docx file via pandoc - the write half
// of the docxToMarkdown round trip, used by "이력서 최적화하기" to turn the
// model's edited markdown back into a downloadable Word document.
async function markdownToDocx(markdownText, outPath) {
  const workDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'o2s-md2docx-'));
  const mdPath = path.join(workDir, 'input.md');
  fs.writeFileSync(mdPath, markdownText, 'utf8');
  try {
    await execFileAsync('pandoc', [mdPath, '-f', 'markdown', '-o', outPath]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Builds an equal-time-per-slide slideshow (PDF pages) muxed with the audio
// track, sized/padded (black bars) to `width`x`height`. Pass `maxDuration` to
// cut the output short (used for the Shorts clip) - the per-slide pacing is
// still computed from the full `duration` so slides don't speed up.
async function buildSlideshow({ images, audioPath, duration, outPath, width = 1920, height = 1080, maxDuration }) {
  const perSlide = duration / images.length;
  const listPath = `${outPath}.list.txt`;
  const escape = (p) => p.replace(/'/g, "'\\''");
  const lines = images.map((img) => `file '${escape(img)}'\nduration ${perSlide.toFixed(3)}`);
  // The concat demuxer ignores the last entry's duration, so it must be repeated.
  lines.push(`file '${escape(images[images.length - 1])}'`);
  fs.writeFileSync(listPath, lines.join('\n'));

  const args = [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-i', audioPath,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`,
    // veryfast cuts encode time substantially versus libx264's "medium"
    // default (~30% faster in testing) for a barely-worse-quality tradeoff
    // that's irrelevant here - a near-static slideshow, not a detail-heavy
    // source. This directly matters because the request holds the client's
    // fetch() open for the entire encode (audio length, often many minutes)
    // with zero progress feedback - the longer that window, the more likely
    // something in between (laptop sleep, Wi-Fi, a router's idle-connection
    // timeout) kills the connection before ffmpeg ever finishes, surfacing
    // to the user as a plain "Failed to fetch" with no real server error.
    '-c:v', 'libx264', '-preset', 'veryfast', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
  ];
  if (maxDuration) args.push('-t', String(maxDuration));
  args.push(outPath);

  try {
    await execFileAsync('ffmpeg', args);
  } finally {
    fs.unlinkSync(listPath);
  }
}

module.exports = {
  findAudioAndPdf,
  findPdf,
  findDocx,
  findPy,
  findImage,
  findAudio,
  findVideo,
  convertToWav,
  reencodeToMp4,
  hasAudioStream,
  muxLoopedAudio,
  getAudioDuration,
  pdfToImages,
  pdfText,
  docxToMarkdown,
  markdownToDocx,
  buildSlideshow,
};
