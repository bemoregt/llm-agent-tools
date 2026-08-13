const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { YoutubeTranscript } = require('youtube-transcript');

const execFileAsync = promisify(execFile);

// The trailing char class excludes ) ] * " ' too, not just whitespace - a
// URL wrapped in this wiki's own *...* external-link syntax would otherwise
// swallow the closing * as if it were part of the URL's query string.
// The `shorts/` branch matters for downloadVideo below - a Shorts link
// wouldn't match the watch/embed forms at all otherwise.
const YOUTUBE_URL_RE =
  /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s)\]*"']*v=[\w-]{11}[^\s)\]*"']*|embed\/[\w-]{11}[^\s)\]*"']*|shorts\/[\w-]{11}[^\s)\]*"']*)|youtu\.be\/[\w-]{11}[^\s)\]*"']*)/i;

// Finds the first YouTube URL anywhere in the page's raw text - whether it
// was written as a bare URL, wrapped in *...* (this wiki's external-link
// syntax), or as a [label](url) markdown-style link, the literal URL string
// is present in the raw body either way, so one plain regex over the whole
// text covers all three forms.
function findYoutubeUrl(body) {
  const m = body.match(YOUTUBE_URL_RE);
  return m ? m[0] : null;
}

// No API key needed - YouTube's oEmbed endpoint is a stable, public way to
// get a video's title/author from just its watch URL.
async function getVideoInfo(url) {
  const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  if (!res.ok) throw new Error(`영상 정보를 가져오지 못했습니다 (${res.status}). 비공개 영상이거나 잘못된 링크일 수 있습니다.`);
  const data = await res.json();
  return { title: data.title || '', author: data.author_name || '' };
}

// Pulls the video's caption track (auto-generated captions count) and joins
// it into plain text. Deliberately does NOT fall back to anything else if
// there's no transcript - a video with captions disabled/unavailable simply
// can't be summarized this way, and the caller should say so rather than
// pretend to have watched it.
async function getTranscriptText(url, maxChars = 8000) {
  const items = await YoutubeTranscript.fetchTranscript(url);
  const text = items
    .map((it) => it.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error('이 영상에서 자막 텍스트를 추출하지 못했습니다.');
  return text.slice(0, maxChars);
}

// Downloads a YouTube video (Shorts or regular) to `outPath` via the system
// yt-dlp binary - this app shells out to CLI tools throughout (see
// lib/video.js's ffmpeg/ffprobe/pdftoppm/pandoc calls) rather than pulling
// in an npm wrapper package, so this follows the same convention.
//
// Deliberately does NOT filter by ext=mp4/m4a: YouTube's format list shifts
// under yt-dlp constantly (e.g. its formats can come back HLS-only, with
// both video and audio labeled ext=mp4 even though neither is a plain
// progressive mp4), so a strict ext filter can leave zero matching formats
// on an otherwise-downloadable video. Picking the best available
// video+audio unconditionally, capped at 1080p (Shorts don't need more, and
// this avoids wastefully pulling a 4K source), and then unconditionally
// re-encoding to H.264/AAC mp4 - the same guarantee lib/video.js's
// reencodeToMp4 makes for every other generated video in this app - means
// whatever codec/container yt-dlp actually handed back still ends up
// playable by the <video> tag lib/wiki.js renders for /uploads links.
async function downloadVideo(url, outPath) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-ytdl-'));
  try {
    const rawTemplate = path.join(workDir, 'raw.%(ext)s');
    try {
      await execFileAsync(
        'yt-dlp',
        [
          '--no-playlist',
          '-q',
          '--no-warnings',
          '-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
          '-o', rawTemplate,
          url,
        ],
        { maxBuffer: 1024 * 1024 * 20 }
      );
    } catch (err) {
      const detail = (err.stderr || err.message || '').toString().trim().slice(0, 300);
      throw new Error(`영상을 다운로드하지 못했습니다: ${detail}`);
    }

    const downloaded = fs.readdirSync(workDir)[0];
    if (!downloaded) throw new Error('영상을 다운로드하지 못했습니다 (알 수 없는 오류).');

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', path.join(workDir, downloaded),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      outPath,
    ]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { findYoutubeUrl, getVideoInfo, getTranscriptText, downloadVideo };
