require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const multer = require('multer');
const RSSParser = require('rss-parser');
const wiki = require('./lib/wiki');
const ollama = require('./lib/ollama');
const video = require('./lib/video');
const musicgen = require('./lib/musicgen');
const arxiv = require('./lib/arxiv');
const youtube = require('./lib/youtube');
const codetest = require('./lib/codetest');
const notebook = require('./lib/notebook');
const kernel = require('./lib/kernel');
const screenshot = require('./lib/screenshot');

const rssParser = new RSSParser();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// Vendored third-party libraries (e.g. mermaid.js) don't change on every
// edit like the hand-written files below, so they get normal HTTP caching
// instead of the no-store policy - otherwise the browser would re-download
// several MB of it on every single page view.
app.use('/static/vendor', express.static(path.join(__dirname, 'public', 'vendor')));
app.use(
  '/static',
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-store'),
  })
);

const PORT = process.env.PORT || 3000;

// The front page ("index") is world-editable like any other wiki page, but
// it's the first thing visitors land on - require a login before any write
// to it goes through, while every other page stays open.
const INDEX_EDIT_AUTH = { user: 'very', pass: 'good' };

function requireIndexAuth(req, res, next) {
  if (req.params.name !== 'index') return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user === INDEX_EDIT_AUTH.user && pass === INDEX_EDIT_AUTH.pass) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="index-edit"');
  res.status(401).send('index 페이지를 편집하려면 로그인이 필요합니다.');
}

// The server binds to all interfaces (see app.listen below), so anyone on
// the same LAN could otherwise POST here - unlike reading a page, this
// route launches a native macOS app (Finder) on the host, so it's worth
// restricting to the machine itself even though the rest of this app
// already assumes a trusted local network per the README.
function requireLocalhost(req, res, next) {
  const ip = req.ip || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).json({ error: '로컬호스트에서만 사용할 수 있는 기능입니다.' });
}

// [label](file:///abs/path) links (see lib/wiki.js) render as a
// finder-link with the path in a data-attribute; finderlink.js intercepts
// the click and POSTs here instead of navigating, so the browser never
// needs (and can't get) direct filesystem access itself.
app.post('/open-in-finder', requireLocalhost, (req, res) => {
  try {
    const targetPath = typeof req.body.path === 'string' ? req.body.path : '';
    if (!targetPath) return res.status(400).json({ error: '경로가 없습니다.' });
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: '해당 경로를 찾을 수 없습니다: ' + targetPath });
    }
    execFileSync('open', [targetPath]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[open-in-finder] error', err);
    res.status(500).json({ error: err.message });
  }
});

const UPLOAD_DIR = path.join(wiki.VAULT_DIR, '_uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Busboy decodes multipart filenames as latin1 by default, but browsers
    // actually send them as raw UTF-8 bytes - re-decode to undo the mojibake.
    const utf8Name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const original = path.basename(utf8Name).replace(/[/\\]/g, '_');
    const ext = path.extname(original);
    const base = path.basename(original, ext) || 'file';
    let candidate = original;
    let i = 1;
    while (fs.existsSync(path.join(UPLOAD_DIR, candidate))) {
      candidate = `${base}-${i}${ext}`;
      i += 1;
    }
    cb(null, candidate);
  },
});
const UPLOAD_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
const upload = multer({ storage: uploadStorage, limits: { fileSize: UPLOAD_MAX_BYTES } });

app.use('/uploads', express.static(UPLOAD_DIR));

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `파일이 너무 큽니다 (최대 ${UPLOAD_MAX_BYTES / (1024 * 1024)}MB)` });
      }
      console.error(err);
      return res.status(400).json({ error: '업로드 실패' });
    }
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    const isImage = /^image\//.test(req.file.mimetype);
    res.json({
      url: `/uploads/${encodeURIComponent(req.file.filename)}`,
      filename: req.file.filename,
      isImage,
    });
  });
});

app.get('/', (req, res) => {
  if (wiki.pageExists('index')) return res.redirect('/page/index');
  res.redirect('/pages');
});

app.get('/pages', (req, res) => {
  res.render('list', { pages: wiki.listPages() });
});

// Used by the glossary button to skip terms that already have a page.
app.get('/api/pages', (req, res) => {
  res.json({ pages: wiki.listPages() });
});

// Used by the sidebar AI status indicator (public/ai-status.js) to show
// which Ollama model is currently answering the page's AI buttons.
app.get('/api/ai-model', (req, res) => {
  res.json({ model: ollama.OLLAMA_MODEL });
});

app.get('/graph', (req, res) => {
  res.render('graph', {});
});

app.get('/api/graph', (req, res) => {
  res.json(wiki.buildTree(req.query.root));
});

app.get('/changes', (req, res) => {
  res.render('changes', { pages: wiki.listPagesWithMtime() });
});

app.get('/help', (req, res) => {
  res.render('help', {});
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  let results = [];
  if (q) {
    const needle = q.toLowerCase();
    for (const name of wiki.listPages()) {
      const { body } = wiki.readPage(name);
      const idx = body.toLowerCase().indexOf(needle);
      if (name.toLowerCase().includes(needle) || idx !== -1) {
        const snippet = idx !== -1 ? body.slice(Math.max(0, idx - 30), idx + 60).trim() : '';
        results.push({ name, snippet });
      }
    }
  }
  res.render('search', { q, results });
});

app.get('/page/:name', (req, res) => {
  const { name } = req.params;
  if (!wiki.pageExists(name)) return res.redirect(`/new/${encodeURIComponent(name)}`);
  const html = wiki.render(name, req.query.cal);
  res.render('view', { name, html });
});

app.get('/page/:name/edit', requireIndexAuth, (req, res) => {
  const { name } = req.params;
  const body = wiki.pageExists(name) ? wiki.readPage(name).body : '';
  res.render('edit', { name, body });
});

app.post('/page/:name', requireIndexAuth, (req, res) => {
  const { name } = req.params;
  wiki.writePage(name, req.body.body || '');

  let finalName = name;
  const newTitle = (req.body.title || '').trim();
  if (newTitle && newTitle !== name) {
    wiki.renamePage(name, newTitle);
    finalName = newTitle;
  }

  res.redirect(`/page/${encodeURIComponent(finalName)}`);
});

// Used by the sidebar file upload widget when viewing (not editing) a page -
// there's no cursor to insert at, so the snippet goes at the very end.
app.post('/page/:name/append', requireIndexAuth, (req, res) => {
  const { name } = req.params;
  const snippet = (req.body && req.body.snippet) || '';
  if (!snippet.trim()) return res.status(400).json({ error: 'no snippet' });

  const current = wiki.pageExists(name) ? wiki.readPage(name).body : '';
  const trimmed = current.replace(/\s+$/, '');
  const newBody = `${trimmed ? `${trimmed}\n\n` : ''}${snippet}\n`;
  wiki.writePage(name, newBody);
  res.json({ ok: true });
});

// "전문용어 페이지 만들기": for each selected foreign-word term, generate a
// short definition with a local Ollama (cloud) model if the term doesn't
// already have a page, then wrap its first occurrence in *term* link syntax.
app.post('/page/:name/glossarize', requireIndexAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const terms = Array.isArray(req.body.terms)
      ? req.body.terms.filter((t) => typeof t === 'string' && t.trim())
      : [];
    if (!terms.length) return res.status(400).json({ error: 'no terms' });
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const created = [];
    const failed = [];
    for (const term of terms) {
      if (wiki.pageExists(term)) continue;
      try {
        const definition = await ollama.defineTerm(term);
        wiki.writePage(term, definition || `(자동 설명 생성 실패: ${term})`);
        created.push(term);
      } catch (err) {
        console.error('[glossarize] failed for', term, err.message);
        failed.push(term);
      }
    }

    const current = wiki.readPage(name).body;
    const { body: linkedBody, linkedTerms } = wiki.linkTermsInBody(current, terms);
    wiki.writePage(name, linkedBody);

    res.json({ ok: true, created, failed, linked: linkedTerms });
  } catch (err) {
    console.error('[glossarize] error', err);
    res.status(500).json({ error: err.message });
  }
});

const CORE_FUNCTION_COUNT = 3;

// "핵심 함수 만들기": asks Ollama to split the page's algorithm into exactly
// 3 fully-implemented functions, then draws a flowchart of the whole with
// those 3 steps highlighted.
app.post('/page/:name/core-function', requireIndexAuth, async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const functions = await ollama.generateCoreFunctions(name, body.slice(0, 6000), CORE_FUNCTION_COUNT);

    const funcName = (code) => {
      const m = code.match(/def\s+(\w+)\s*\(/);
      return m ? m[1] : null;
    };
    const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
    const names = functions.map((f, i) => funcName(f.code) || `함수 ${i + 1}`);
    const sections = functions
      .map((f, i) => {
        const desc = f.explanation ? `${oneLine(f.explanation)}\n\n` : '';
        return `### ${i + 1}. ${names[i]}\n\n\`\`\`python\n${f.code}\n\`\`\`\n\n${desc}`;
      })
      .join('');

    const diagram = await ollama.generateFlowDiagram(name, body.slice(0, 6000), names);
    const flowSection = `### \u{1F5FA}️ 전체 흐름도\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`;

    const snippet = `\n## \u{1F9E9} 핵심 함수\n\n${sections}${flowSection}`;
    appendToPage(name, snippet);

    res.json({ ok: true, functions, diagram });
  } catch (err) {
    console.error('[core-function] error', err);
    res.status(500).json({ error: err.message });
  }
});

// "영어로 번역": the "유튜브 영상 만들기" feature writes "- 제목: ..." and
// "- 설명: ..." lines with the generated video title/description - this pulls
// just those two lines out, translates each with a local Ollama model, and
// appends the result, leaving the rest of the page (and the original Korean
// title/description) untouched.
const VIDEO_TITLE_RE = /^-\s*제목\s*[:：]\s*(.+)$/m;
const VIDEO_DESCRIPTION_RE = /^-\s*설명\s*[:：]\s*(.+)$/m;

app.post('/page/:name/translate', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const titleMatch = body.match(VIDEO_TITLE_RE);
    const descMatch = body.match(VIDEO_DESCRIPTION_RE);
    if (!titleMatch || !descMatch) {
      return res
        .status(400)
        .json({ error: '첨부된 동영상 제목/설명을 찾지 못했습니다. 먼저 🎬 유튜브 영상 만들기로 생성해주세요.' });
    }
    const title = titleMatch[1].trim();
    const description = descMatch[1].trim();

    const [translatedTitle, translatedDescription] = await Promise.all([
      ollama.translateToEnglish(name, title),
      ollama.translateToEnglish(name, description),
    ]);

    const snippet =
      `\n## \u{1F310} Video Title & Description (English)\n\n` +
      `- Title: ${translatedTitle}\n` +
      `- Description: ${translatedDescription}\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, translatedTitle, translatedDescription });
  } catch (err) {
    console.error('[translate] error', err);
    res.status(500).json({ error: err.message });
  }
});

// "키워드로 채용정보 찾기" (1개월 / 1주일): no Ollama involved here on purpose -
// a local model has no internet access and would have to invent company
// names/URLs for any "job listing" it produced, which is exactly the kind of
// fabricated-as-real content this wiki shouldn't generate. Instead this builds
// real search-result links on actual job sites for the page's own title, so
// what's listed always leads to genuine (if unfiltered-by-us) postings.
// LinkedIn's `f_TPR` param (r2592000 = 30 days, r604800 = 7 days) is a
// well-documented recency filter; the three Korean sites don't have an
// equally reliable URL param for either window, so their links land on a
// plain keyword search and the note below asks the reader to apply the
// recency filter themselves once there.
const JOB_SEARCH_PERIODS = {
  month: { label: '1개월', linkedinTPR: 'r2592000' },
  week: { label: '1주일', linkedinTPR: 'r604800' },
};

function buildJobSearchSnippet(keyword, periodKey) {
  const period = JOB_SEARCH_PERIODS[periodKey] || JOB_SEARCH_PERIODS.month;
  const q = encodeURIComponent(keyword);
  const sites = [
    { label: '사람인에서 검색', url: `https://www.saramin.co.kr/zf_user/search/recruit?searchword=${q}` },
    { label: '잡코리아에서 검색', url: `https://www.jobkorea.co.kr/Search/?stext=${q}` },
    { label: '원티드에서 검색', url: `https://www.wanted.co.kr/search?query=${q}&tab=position` },
    {
      label: `LinkedIn에서 검색 (최근 ${period.label})`,
      url: `https://www.linkedin.com/jobs/search/?keywords=${q}&f_TPR=${period.linkedinTPR}`,
    },
  ];

  const list = sites.map((s) => `- [${s.label}](${s.url})`).join('\n');
  const snippet =
    `\n## \u{1F4BC} 채용정보 검색 (최근 ${period.label}): ${keyword}\n\n${list}\n\n` +
    `(사람인/잡코리아/원티드는 사이트에서 직접 "최근 ${period.label}" 등록일 필터를 적용해주세요. LinkedIn 링크는 최근 ${period.label}로 자동 필터링됩니다.)\n`;
  return { snippet, sites };
}

app.post('/page/:name/job-search', (req, res) => {
  const { name } = req.params;
  if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

  const periodKey = req.body && req.body.period === 'week' ? 'week' : 'month';
  const { snippet, sites } = buildJobSearchSnippet(name, periodKey);
  appendToPage(name, snippet);

  res.json({ ok: true, sites });
});

// "키워드로 RSS Feed 찾기": same reasoning as the job-search buttons above - no
// Ollama call, because a local model can't browse the web and would have to
// invent feed URLs. These three are real, keyword-searchable RSS endpoints
// (no API key needed) that return live, genuinely matching results for
// whatever the page's title is.
app.post('/page/:name/rss-search', (req, res) => {
  const { name } = req.params;
  if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

  const keyword = name;
  const q = encodeURIComponent(keyword);
  const feeds = [
    { label: 'Google 뉴스 RSS', url: `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko` },
    { label: 'Bing 뉴스 RSS', url: `https://www.bing.com/news/search?q=${q}&format=RSS` },
    { label: 'Reddit 검색 RSS', url: `https://www.reddit.com/search.rss?q=${q}` },
  ];

  // Link to our own /rss-view proxy (which fetches + renders the feed as a
  // readable list) rather than the raw XML address directly - that page also
  // shows the original feed URL for anyone who wants to subscribe to it in a
  // real feed reader instead. Must be an absolute http(s) URL: [label](url)
  // only renders as a plain link for those - a relative path like
  // "/rss-view?..." would instead match the uploaded-file download-link
  // branch and get a `download` attribute, popping a save dialog instead of
  // navigating to the page.
  const origin = `${req.protocol}://${req.get('host')}`;
  const list = feeds
    .map((f) => `- [${f.label}](${origin}/rss-view?url=${encodeURIComponent(f.url)}&label=${encodeURIComponent(f.label)})`)
    .join('\n');
  const snippet = `\n## \u{1F4E1} RSS Feed 검색: ${keyword}\n\n${list}\n`;
  appendToPage(name, snippet);

  res.json({ ok: true, feeds });
});

// Fetches and parses a real RSS/Atom feed URL server-side and renders it as a
// readable list instead of sending the reader to raw XML.
app.get('/rss-view', async (req, res) => {
  const feedUrl = req.query.url;
  if (!feedUrl || !/^https?:\/\//i.test(feedUrl)) {
    return res.status(400).send('<pre>잘못된 RSS 주소입니다.</pre>');
  }
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const items = (feed.items || []).slice(0, 50).map((item) => ({
      title: item.title || '(제목 없음)',
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || '',
      snippet: (item.contentSnippet || item.summary || item.content || '').trim().slice(0, 300),
    }));
    res.render('rss', {
      feedTitle: feed.title || req.query.label || 'RSS Feed',
      feedUrl,
      items,
    });
  } catch (err) {
    console.error('[rss-view] error', err);
    res.status(502).send(`<pre>RSS Feed를 불러오지 못했습니다: ${err.message}</pre>`);
  }
});

// "한글로 번역하기" on the RSS feed viewer: the viewer isn't a wiki page (it's
// a live-fetched feed, nothing in the vault to append to), so this just
// translates the given items in one batched Ollama call and hands the
// translations back for the page to inject in place next to each item.
const RSS_TRANSLATE_MAX_ITEMS = 30;

app.post('/rss-translate', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items)
      ? req.body.items.slice(0, RSS_TRANSLATE_MAX_ITEMS).map((it) => ({
          title: typeof it.title === 'string' ? it.title : '',
          snippet: typeof it.snippet === 'string' ? it.snippet : '',
        }))
      : [];
    if (!items.length) return res.status(400).json({ error: 'no items' });

    const translations = await ollama.translateFeedItemsToKorean(items);
    res.json({ ok: true, translations });
  } catch (err) {
    console.error('[rss-translate] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Same collision-avoidance scheme as the multer upload's filename callback
// above, but synchronous and reusable for files this server downloads
// itself (arXiv PDFs) rather than ones a browser uploaded.
function uniqueUploadFilename(desiredName) {
  const ext = path.extname(desiredName);
  const base = path.basename(desiredName, ext) || 'file';
  let candidate = desiredName;
  let i = 1;
  while (fs.existsSync(path.join(UPLOAD_DIR, candidate))) {
    candidate = `${base}-${i}${ext}`;
    i += 1;
  }
  return candidate;
}

// "비구름 사진 첨부하기": headlessly captures Windy.com's rain-radar view
// (lib/screenshot.js, driving the Brave install already on this Mac) and
// uploads it to the page as a new image, timestamped so repeated clicks
// build up a history of snapshots over time rather than overwriting the
// last one - unlike the regenerate-in-place features above, "what did the
// rain radar look like right now" is inherently a point-in-time fact worth
// keeping each time, not a single fresh-per-click result.
app.post('/page/:name/rain-photo', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const buf = await screenshot.captureWindyRain();

    const stamp = new Date()
      .toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' })
      .replace(/[: ]/g, '-');
    const filename = uniqueUploadFilename(`rain-${stamp}.png`);
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);

    const caption = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const snippet = `\n![${filename}](/uploads/${encodeURIComponent(filename)})\n- ☁️ 비 구름 (windy.com, ${caption} 기준)\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, filename });
  } catch (err) {
    console.error('[rain-photo] error', err);
    res.status(500).json({ error: '비구름 사진을 가져오지 못했습니다: ' + err.message });
  }
});

// Matches the first plain http(s) URL anywhere in a page's raw markdown -
// whether typed bare, wrapped in a markdown link `[label](url)`, or inside
// an image tag `![alt](url)` - stopping at the first character that can't
// be part of a URL so it doesn't swallow the surrounding markdown syntax.
function findFirstExternalUrl(body) {
  const match = body.match(/https?:\/\/[^\s)\]"'<>]+/);
  return match ? match[0] : null;
}

// "웹페이지 캡쳐": finds the first external link in the page, opens it
// headlessly (lib/screenshot.js's captureFullPageScroll) and scrolls all the
// way through it, screenshotting each viewport-sized step rather than one
// giant stitched image. Like the rain-radar photo above, this is a
// point-in-time capture of an external page's current state, so repeated
// clicks append a new numbered set of images instead of overwriting the
// last capture.
app.post('/page/:name/web-capture', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const url = findFirstExternalUrl(body);
    if (!url) {
      return res.status(400).json({ error: '문서에서 캡쳐할 외부 링크(http/https)를 찾지 못했습니다.' });
    }

    const shots = await screenshot.captureFullPageScroll(url);
    if (!shots.length) {
      return res.status(500).json({ error: '페이지를 캡쳐하지 못했습니다.' });
    }

    const stamp = new Date()
      .toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' })
      .replace(/[: ]/g, '-');
    const filenames = shots.map((buf, i) => {
      const filename = uniqueUploadFilename(`capture-${stamp}-${String(i + 1).padStart(2, '0')}.png`);
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
      return filename;
    });

    const caption = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const imageLines = filenames.map((f) => `![${f}](/uploads/${encodeURIComponent(f)})`).join('\n');
    const snippet =
      `\n## \u{1F4F7} 웹페이지 캡쳐: ${url}\n\n` +
      `${imageLines}\n` +
      `- \u{1F4F7} 전체 페이지 캡쳐 (${filenames.length}장, ${caption} 기준)\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, url, count: filenames.length, filenames });
  } catch (err) {
    console.error('[web-capture] error', err);
    res.status(500).json({ error: '웹페이지를 캡쳐하지 못했습니다: ' + err.message });
  }
});

// "키워드로 최신 arXiv 논문 찾기" (1개월 / 1주일): unlike the job/RSS search
// buttons, this one has a real, structured, date-filterable API to call
// (arXiv's own), so it's used directly rather than routing through a plain
// keyword search URL. Matching papers' PDFs are downloaded and uploaded to
// this page automatically - capped at ARXIV_MAX_RESULTS so a broad keyword
// can't silently pull down a large batch of files.
const ARXIV_MAX_RESULTS = 5;

app.post('/page/:name/arxiv-search', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const periodKey = req.body && req.body.period === 'week' ? 'week' : 'month';
    const periodLabel = periodKey === 'week' ? '1주일' : '1개월';
    const papers = await arxiv.searchRecent(name, { periodKey, maxResults: ARXIV_MAX_RESULTS });

    if (!papers.length) {
      return res.json({
        ok: true,
        papers: [],
        message: `최근 ${periodLabel} 내 "${name}" 관련 신규 arXiv 논문을 찾지 못했습니다.`,
      });
    }

    const downloaded = [];
    // Downloaded sequentially per-paper (not Promise.all) so one slow or
    // failing download can't take the whole batch down with it - a paper
    // that fails just falls back to a plain abstract-page link instead.
    const lines = papers.map((paper) => ({
      paper,
      filename: uniqueUploadFilename(`${arxiv.sanitizeArxivId(paper.arxivId)}.pdf`),
      fileLine: null,
    }));

    for (const item of lines) {
      const { paper, filename } = item;
      try {
        const buf = await arxiv.downloadPdf(paper.pdfUrl);
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
        downloaded.push(filename);
        item.fileLine = `-- [PDF: ${filename}](/uploads/${encodeURIComponent(filename)})`;
      } catch (err) {
        console.error('[arxiv-search] pdf download failed for', paper.arxivId, err.message);
        item.fileLine = `-- PDF 자동 다운로드 실패 (초록 페이지에서 직접 받아주세요)`;
      }
    }

    const authorLine = (paper) => {
      const names = paper.authors.filter(Boolean);
      if (!names.length) return '정보 없음';
      return names.length > 5 ? `${names.slice(0, 5).join(', ')} 외` : names.join(', ');
    };

    const body = lines
      .map(
        ({ paper, fileLine }) =>
          `- ${paper.title} (${paper.published.slice(0, 10)})\n` +
          `-- 저자: ${authorLine(paper)}\n` +
          `-- [초록 보기](${paper.absUrl})\n` +
          `${fileLine}`
      )
      .join('\n');
    const snippet = `\n## \u{1F4DA} arXiv 논문 검색 (최근 ${periodLabel}): ${name}\n\n${body}\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, papers, downloaded });
  } catch (err) {
    console.error('[arxiv-search] error', err);
    res.status(500).json({ error: err.message });
  }
});

// "첨부 PDF 논문 요약": summarizes a PDF already uploaded and linked on this
// page (extracted locally via poppler's pdftotext, same tool the video
// feature uses) into three fixed Korean sections via Ollama.
app.post('/page/:name/pdf-summary', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const pdf = video.findPdf(body, UPLOAD_DIR);
    if (!pdf) {
      return res.status(400).json({ error: '첨부된 PDF를 찾지 못했습니다. 먼저 PDF 파일을 업로드해서 문서에 링크해주세요.' });
    }

    const pdfTextContent = await video.pdfText(pdf.abs, 8000);
    if (!pdfTextContent.trim()) {
      return res.status(400).json({ error: 'PDF에서 텍스트를 추출하지 못했습니다 (스캔본 이미지 PDF일 수 있습니다).' });
    }

    const summary = await ollama.summarizePaper(name, pdfTextContent);
    const snippet =
      `\n## \u{1F4C4} 논문 요약: ${pdf.filename}\n\n` +
      `- 핵심 기여: ${summary.contribution || '(생성 실패)'}\n` +
      `- 방법론: ${summary.methodology || '(생성 실패)'}\n` +
      `- 실험 결과: ${summary.results || '(생성 실패)'}\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, summary, filename: pdf.filename });
  } catch (err) {
    console.error('[pdf-summary] error', err);
    res.status(500).json({ error: err.message });
  }
});

// "이력서 최적화하기": reads an attached .docx resume (extracted to markdown
// via pandoc, see lib/video.js) and the page's own body text (expected to
// describe the target company/job posting), asks Ollama to reword/reorder
// the resume to match that posting without inventing new history, then
// renders the result back into a real .docx (pandoc again) and attaches it.
app.post('/page/:name/resume-optimize', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const resume = video.findDocx(body, UPLOAD_DIR);
    if (!resume) {
      return res
        .status(400)
        .json({ error: '첨부된 이력서(.docx) 파일을 찾지 못했습니다. 먼저 이력서 파일을 업로드해서 문서에 링크해주세요.' });
    }

    const resumeMarkdown = await video.docxToMarkdown(resume.abs);
    if (!resumeMarkdown.trim()) {
      return res.status(400).json({ error: '이력서에서 텍스트를 추출하지 못했습니다.' });
    }

    const { optimizedMarkdown, changes } = await ollama.optimizeResume(body, resumeMarkdown);

    const outFilename = uniqueUploadFilename(`${wiki.sanitizeName(name)}-최적화이력서.docx`);
    const outPath = path.join(UPLOAD_DIR, outFilename);
    await video.markdownToDocx(optimizedMarkdown, outPath);

    const changesList = changes
      ? changes
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join('\n')
      : '- (변경사항 요약 생성 실패)';
    const snippet =
      `\n## \u{1F4DD} 이력서 최적화 결과\n\n` +
      `- 원본: ${resume.filename}\n` +
      `- 주요 변경사항:\n${changesList}\n\n` +
      `[${outFilename}](/uploads/${encodeURIComponent(outFilename)})\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, filename: outFilename, changes });
  } catch (err) {
    console.error('[resume-optimize] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Pulls the Python source this feature should convert: prefers a
// ```python fenced code block, then a multiline <code>...</code> block,
// falling back to an attached .py file. The tag form is supported because
// this wiki renderer also treats <code> and </code> on their own lines as a
// Python code block.
function extractPythonSource(body, uploadDir) {
  const fenced = body.match(/```python\r?\n([\s\S]*?)```/);
  if (fenced) return { code: fenced[1], sourceLabel: '문서 안 코드 블록' };

  // Require line breaks around the tags so an inline `<code>x</code>` span
  // is not accidentally converted into a notebook. Attributes are accepted
  // for compatibility with ordinary HTML code-block markup.
  const tagged = body.match(
    /(?:^|\r?\n)[ \t]*<code(?:\s[^>]*)?>[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<\/code>[ \t]*(?=\r?\n|$)/i
  );
  if (tagged) return { code: tagged[1], sourceLabel: '문서 안 <code> 블록' };

  const pyFile = video.findPy(body, uploadDir);
  if (pyFile) return { code: fs.readFileSync(pyFile.abs, 'utf8'), sourceLabel: pyFile.filename };
  return null;
}

// "주피터 노트북으로 변경": converts the page's attached Python code into a
// real, runnable .ipynb (hand-built nbformat-4.5 JSON - no nbformat/jupyter
// package installed, but the format is just documented JSON) and renders it
// inline as an actual per-cell interactive notebook - each cell gets its own
// "▶ 실행" button (lib/notebook.js's renderNotebookHtml, wired up by
// lib/wiki.js), backed by a real persistent Python process per page
// (lib/kernel.js + lib/kernel_worker.py) so cells share state across
// separate button clicks exactly like a real Jupyter kernel's global scope,
// rather than a fresh interpreter per click. Shares codetest's safety
// blocklist since this runs server-provided code directly on the host.
function notebookFilenameFor(name) {
  return `${wiki.sanitizeName(name)}.ipynb`;
}

function persistNotebookSession(name, cells) {
  const nb = notebook.buildNotebookJson(name, cells);
  const outFilename = notebookFilenameFor(name);
  fs.writeFileSync(path.join(UPLOAD_DIR, outFilename), JSON.stringify(nb, null, 1));
  const snippet =
    `\n## \u{1F4D3} 주피터 노트북으로 변경\n\n` +
    `- 각 셀의 ▶ 실행 버튼을 눌러 순서대로 하나씩 실행하세요 (이전 셀에서 만든 변수를 다음 셀에서 그대로 쓸 수 있습니다).\n\n` +
    `[${outFilename}](/uploads/${encodeURIComponent(outFilename)})\n`;
  replaceSection(name, '\u{1F4D3} 주피터 노트북으로 변경', snippet);
  return outFilename;
}

// Parses fresh cells from the page and starts a brand new kernel session
// for it - used both by the explicit "(재)시작" click and, transparently,
// by run-cell when no session exists yet (server restarted, kernel idled
// out, or this is the very first run).
function startNotebookSession(name, body) {
  const source = extractPythonSource(body, UPLOAD_DIR);
  if (!source) {
    const err = new Error('변환할 파이썬 코드를 찾지 못했습니다. 문서에 ```python 또는 <code>...</code> 코드 블록을 넣거나 .py 파일을 첨부해주세요.');
    err.status = 400;
    throw err;
  }
  const sources = notebook.parseCodeIntoCells(source.code);
  if (!sources.length) {
    const err = new Error('코드에서 실행 가능한 내용을 찾지 못했습니다.');
    err.status = 400;
    throw err;
  }
  sources.forEach((s) => codetest.checkCodeSafety(s));

  const k = kernel.startKernel(name);
  k.cells = sources.map((s) => ({ source: s, execution_count: null, outputs: [] }));
  return k;
}

app.post('/page/:name/to-notebook', (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });
    const { body } = wiki.readPage(name);

    const k = startNotebookSession(name, body);
    persistNotebookSession(name, k.cells);

    res.json({ ok: true, cellCount: k.cells.length });
  } catch (err) {
    console.error('[to-notebook] error', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/page/:name/notebook/run-cell', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });
    const index = Number(req.body && req.body.index);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: 'invalid cell index' });
    }

    let k = kernel.getKernel(name);
    if (!k) {
      const { body } = wiki.readPage(name);
      k = startNotebookSession(name, body);
    }
    if (index >= k.cells.length) {
      return res.status(400).json({ error: '더 이상 셀이 없습니다. 노트북을 다시 시작해주세요.' });
    }

    const cellState = k.cells[index];
    // The client sends the textarea's *current* value, which may differ from
    // what this cell last ran (the user edited it in place) - that becomes
    // the cell's new source going forward, same as editing a real Jupyter
    // cell before pressing run.
    const editedCode = typeof req.body.code === 'string' ? req.body.code : cellState.source;
    codetest.checkCodeSafety(editedCode);

    const result = await kernel.runCell(name, editedCode);
    k.execCounter = (k.execCounter || 0) + 1;
    cellState.source = editedCode;
    cellState.execution_count = k.execCounter;
    cellState.outputs = result.outputs;

    persistNotebookSession(name, k.cells);

    res.json({ ok: true, index, execution_count: cellState.execution_count, outputs: cellState.outputs });
  } catch (err) {
    console.error('[notebook/run-cell] error', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// "관련 문서 추천": candidates come from the wiki's own *link* graph (up to
// 2 hops away, nearest first via wiki.findRelatedPages) - never invented by
// the model - and Ollama is only asked to explain, in one line each, why an
// already-established connection exists.
const RELATED_MAX_RESULTS = 5;

app.post('/page/:name/related-pages', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const related = wiki.findRelatedPages(name, RELATED_MAX_RESULTS);
    if (!related.length) {
      return res.json({ ok: true, related: [], message: '이 문서와 링크로 연결된 다른 페이지를 찾지 못했습니다.' });
    }

    const { body: currentBody } = wiki.readPage(name);
    const items = [];
    for (const r of related) {
      const { body: relatedBody } = wiki.readPage(r.id);
      let reason = '';
      try {
        reason = await ollama.explainRelation(name, currentBody.slice(0, 1500), r.id, relatedBody.slice(0, 1500));
      } catch (err) {
        console.error('[related-pages] explain failed for', r.id, err.message);
      }
      items.push({ name: r.id, distance: r.distance, reason });
    }

    const lines = items.map((it) => `- *${it.name}*${it.reason ? `\n-- ${it.reason}` : ''}`).join('\n');
    const snippet = `\n## \u{1F517} 관련 문서 추천\n\n${lines}\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, related: items });
  } catch (err) {
    console.error('[related-pages] error', err);
    res.status(500).json({ error: err.message });
  }
});

// "유튜브 영상 분석 및 요약": Ollama can't watch video, so this finds the
// first YouTube link anywhere in the page, pulls its actual caption track
// (auto-generated captions count) via lib/youtube.js, and only THEN asks
// Ollama to summarize that transcript text. A video with no captions simply
// can't be summarized this way and returns an error instead of a guess.
app.post('/page/:name/youtube-summary', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const url = youtube.findYoutubeUrl(body);
    if (!url) {
      return res.status(400).json({ error: '첨부된 유튜브 링크를 찾지 못했습니다. 먼저 유튜브 영상 링크를 문서에 추가해주세요.' });
    }

    const info = await youtube.getVideoInfo(url);
    let transcript;
    try {
      transcript = await youtube.getTranscriptText(url);
    } catch (err) {
      console.error('[youtube-summary] transcript fetch failed for', url, err.message);
      return res
        .status(400)
        .json({ error: '이 영상은 자막이 없거나 자막을 가져올 수 없어 요약할 수 없습니다 (자동 생성 자막 포함해서 확인했습니다).' });
    }

    const result = await ollama.summarizeYoutubeVideo(name, info.title || url, transcript);
    const pointsLines = result.points.map((p) => `-- ${p}`).join('\n');
    const snippet =
      `\n## \u{1F3A5} 유튜브 영상 요약: ${info.title || url}\n\n` +
      `- 요약: ${result.summary || '(생성 실패)'}\n` +
      (result.points.length ? `- 핵심 포인트:\n${pointsLines}\n` : '');
    appendToPage(name, snippet);

    res.json({ ok: true, title: info.title, summary: result.summary, points: result.points });
  } catch (err) {
    console.error('[youtube-summary] error', err);
    res.status(500).json({ error: err.message });
  }
});

// "코드로 테스트하기": generates the one function this page's algorithm
// needs (lib/ollama.js) - process_image or process_audio, whichever the
// page's own content actually calls for - then actually RUNS it locally
// against a matching file already attached to the page (lib/codetest.js)
// and uploads whatever it produces. This is the one AI feature in this app
// that executes generated code rather than just displaying it - see
// lib/codetest.js for the (best-effort, not a real sandbox) safety measures
// around that.
// Builds { name: value } from the parameter schema's own defaults, coerced
// to the right JS type (slider -> number, combobox -> string) - used both to
// run the very first execution and as the starting point for the page's
// live controls.
function defaultParamValues(params) {
  const values = {};
  for (const p of params) {
    if (!p || typeof p.name !== 'string') continue;
    values[p.name] = p.type === 'slider' ? Number(p.default) : p.default;
  }
  return values;
}

// The parameter schema (plus input/output modality) only exists in memory
// right after generation - for a page reload (or someone else opening the
// page later) to still show live slider/dropdown controls instead of a dead
// static result, this needs to travel WITH the saved code itself. A leading
// Python comment is a harmless place to smuggle it: it doesn't affect
// execution, and the client-side scanner (public/codetest.js) recovers it
// later from the rendered code block's own text content.
const CODETEST_PARAMS_PREFIX = '# CODETEST_PARAMS: ';

function embedParamsComment(code, { inputType, outputType, params }) {
  if (!params || !params.length) return code;
  const meta = { input_type: inputType, output_type: outputType, params };
  return `${CODETEST_PARAMS_PREFIX}${JSON.stringify(meta)}\n${code}`;
}

// Inverse of embedParamsComment - used by the preview route, which only
// gets the raw code text back from the browser (not the original
// generation's separate inputType/outputType/params values), so it has to
// recover them from the comment the same way the client-side scanner does.
// Old pages saved before output/input types existed just had a bare params
// array as the comment body; those are treated as image-in/image-out, which
// was the only behavior that existed when they were written.
function parseEmbeddedMeta(code) {
  const validType = (v) => (v === 'audio' || v === 'video' ? v : 'image');
  const m = code.match(/^#\s*CODETEST_PARAMS:\s*(.+)$/m);
  if (!m) return { inputType: 'image', outputType: 'image', params: [] };
  try {
    const parsed = JSON.parse(m[1]);
    if (Array.isArray(parsed)) return { inputType: 'image', outputType: 'image', params: parsed };
    return {
      inputType: validType(parsed.input_type),
      outputType: validType(parsed.output_type),
      params: Array.isArray(parsed.params) ? parsed.params : [],
    };
  } catch {
    return { inputType: 'image', outputType: 'image', params: [] };
  }
}

const CODE_TEST_OUTPUT_EXT = { image: '.png', audio: '.wav', video: '.mp4' };
const CODE_TEST_OUTPUT_MIME = { image: 'image/png', audio: 'audio/wav', video: 'video/mp4' };

// Finds the attachment the algorithm actually needs (image/audio/video, per
// inputType) and returns an { inputPath, cleanup } pair - for audio,
// inputPath points at a freshly ffmpeg-converted WAV copy in a scratch
// directory that `cleanup()` removes afterward; image and video are handed
// to the generated code as their original upload path unchanged (cv2 reads
// both directly via its own ffmpeg backend), so cleanup() is a no-op there.
async function resolveCodeTestInput(inputType, body) {
  if (inputType === 'audio') {
    const audio = video.findAudio(body, UPLOAD_DIR);
    if (!audio) {
      const err = new Error('이 알고리즘은 오디오 입력이 필요합니다. 먼저 입력으로 쓸 오디오 파일을 문서에 업로드해주세요.');
      err.status = 400;
      throw err;
    }
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-codetest-audio-'));
    const wavPath = path.join(scratchDir, 'input.wav');
    await video.convertToWav(audio.abs, wavPath);
    return { inputPath: wavPath, cleanup: () => fs.rmSync(scratchDir, { recursive: true, force: true }) };
  }

  if (inputType === 'video') {
    const vid = video.findVideo(body, UPLOAD_DIR);
    if (!vid) {
      const err = new Error('이 알고리즘은 비디오 입력이 필요합니다. 먼저 입력으로 쓸 비디오 파일을 문서에 업로드해주세요.');
      err.status = 400;
      throw err;
    }
    return { inputPath: vid.abs, cleanup: () => {} };
  }

  const image = video.findImage(body, UPLOAD_DIR);
  if (!image) {
    const err = new Error('이 알고리즘은 이미지 입력이 필요합니다. 먼저 입력으로 쓸 이미지를 문서에 업로드해주세요.');
    err.status = 400;
    throw err;
  }
  return { inputPath: image.abs, cleanup: () => {} };
}

// A generated process_video()'s own cv2.VideoWriter output is whatever
// codec/container it happened to pick, which is not reliably something a
// browser can play - re-encode to plain H.264 MP4 (ffmpeg auto-detects the
// real bitstream regardless of what extension runProcess gave it) before
// this ever reaches a page. No-op for image/audio output.
async function finalizeOutputBuffer(buf, outputType) {
  if (outputType !== 'video') return buf;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-codetest-reencode-'));
  try {
    const rawPath = path.join(scratchDir, 'raw.mp4');
    const finalPath = path.join(scratchDir, 'final.mp4');
    fs.writeFileSync(rawPath, buf);
    await video.reencodeToMp4(rawPath, finalPath);
    return fs.readFileSync(finalPath);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

app.post('/page/:name/code-test', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const generated = await ollama.generateImageProcessingCode(name, body.slice(0, 6000));
    const { inputType, outputType, params } = generated;
    const code = embedParamsComment(generated.code, generated);
    const values = defaultParamValues(params);

    let input;
    try {
      input = await resolveCodeTestInput(inputType, body);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    let buf;
    try {
      const outputExt = CODE_TEST_OUTPUT_EXT[outputType];
      const timeoutMs = inputType === 'video' ? codetest.VIDEO_RUN_TIMEOUT_MS : undefined;
      buf = await codetest.runProcess({ code, inputPath: input.inputPath, params: values, outputExt, timeoutMs });
      buf = await finalizeOutputBuffer(buf, outputType);
    } catch (err) {
      console.error('[code-test] execution failed for', name, err.message);
      return res.status(400).json({ error: err.message });
    } finally {
      input.cleanup();
    }

    const outFilename = uniqueUploadFilename(
      `${wiki.sanitizeName(name)}-result-${Date.now()}${CODE_TEST_OUTPUT_EXT[outputType]}`
    );
    fs.writeFileSync(path.join(UPLOAD_DIR, outFilename), buf);

    // Uploaded audio/video results use this wiki's plain [label](url)
    // file-link syntax (which renders as an <audio>/<video controls> player
    // based on the extension, matching how any other attached media is
    // shown) - image results keep the existing ![alt](url) inline-image
    // syntax.
    const resultLine =
      outputType === 'image'
        ? `![테스트 결과](/uploads/${encodeURIComponent(outFilename)})`
        : `[${outFilename}](/uploads/${encodeURIComponent(outFilename)})`;
    const snippet = `\n## \u{1F9EA} 코드로 테스트하기 결과\n\n` + `\`\`\`python\n${code}\n\`\`\`\n\n` + `${resultLine}\n`;
    appendToPage(name, snippet);

    res.json({
      ok: true,
      code,
      codeHtml: wiki.highlightCode(code, 'python'),
      inputType,
      outputType,
      params,
      values,
      resultUrl: `/uploads/${encodeURIComponent(outFilename)}`,
    });
  } catch (err) {
    console.error('[code-test] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Live parameter-preview: re-runs the SAME already-generated code (no fresh
// Ollama call) with new slider/dropdown values from the page, and returns
// the result as a data URL rather than writing anything to /uploads - a
// slider being dragged around shouldn't leave a trail of throwaway files
// behind, or repeatedly rewrite the page's saved markdown. The persisted
// page content (from the initial click above) always keeps showing the
// default-parameter result; this endpoint only feeds the live, in-page
// preview media while the reader is actively experimenting.
app.post('/page/:name/code-test/preview', async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const code = typeof req.body.code === 'string' ? req.body.code : '';
    if (!code || !/def\s+(process_image|process_audio|process_video)\s*\(/.test(code)) {
      return res.status(400).json({ error: '유효하지 않은 코드입니다.' });
    }
    const values = req.body.values && typeof req.body.values === 'object' ? req.body.values : {};
    const { inputType, outputType } = parseEmbeddedMeta(code);

    const { body } = wiki.readPage(name);
    let input;
    try {
      input = await resolveCodeTestInput(inputType, body);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    try {
      const outputExt = CODE_TEST_OUTPUT_EXT[outputType];
      const timeoutMs = inputType === 'video' ? codetest.VIDEO_RUN_TIMEOUT_MS : undefined;
      let buf = await codetest.runProcess({ code, inputPath: input.inputPath, params: values, outputExt, timeoutMs });
      buf = await finalizeOutputBuffer(buf, outputType);
      res.json({ ok: true, dataUrl: `data:${CODE_TEST_OUTPUT_MIME[outputType]};base64,${buf.toString('base64')}` });
    } finally {
      input.cleanup();
    }
  } catch (err) {
    console.error('[code-test-preview] error', err);
    res.status(500).json({ error: err.message });
  }
});

const SHORTS_MAX_SECONDS = 180;

// Section heading used by "openFrameworks 앱 코드 만들기" - re-running the
// button replaces this whole section (via replaceSection) instead of piling
// up another copy on every click.
const OF_PROJECT_HEADING = '⚙️ OpenFrameworks 앱 코드';

// "openFrameworks 앱 코드 만들기": asks Ollama to write a complete
// openFrameworks (C++) project - src/main.cpp, src/ofApp.h, src/ofApp.cpp -
// for the app this page describes, zips the whole src/ tree plus a short
// build note into /uploads, and shows each generated file's code on the page
// so it can be read (or copied out) without downloading anything. The zip is
// a bonus convenience, not the point: the code lives on the page itself.
app.post('/page/:name/openframeworks-code', requireIndexAuth, async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const files = await ollama.generateOpenFrameworksCode(name, body.slice(0, 6000));

    // Page names are often Korean - collapse to a safe ASCII slug, and strip
    // leading/trailing '-' / '.' so the name can never be misread as a shell
    // or zip option flag.
    const projectName =
      (wiki.sanitizeName(name) || 'of-app')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+/, '')
        .replace(/[-.]+$/, '') || 'of-app';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-of-'));
    const projectRoot = path.join(workDir, projectName);
    let zipName = null;
    try {
      fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
      for (const f of files) {
        // Filenames come straight from the model - refuse anything that would
        // escape the project root before it touches disk.
        const abs = path.resolve(projectRoot, f.filename);
        if (abs !== projectRoot && !abs.startsWith(projectRoot + path.sep)) continue;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.code.endsWith('\n') ? f.code : `${f.code}\n`);
      }
      fs.writeFileSync(path.join(projectRoot, 'README.md'), ofProjectReadme(projectName, name));

      zipName = uniqueUploadFilename(`${projectName}-of-app.zip`);
      execFileSync('zip', ['-r', '-q', path.join(UPLOAD_DIR, zipName), projectName], { cwd: workDir });
    } catch (err) {
      console.error('[openframeworks-code] zip failed', err);
      throw new Error('앱 코드 압축 파일 생성에 실패했습니다.');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    const sections = files
      .map((f) => `### ${f.filename}\n\n\`\`\`cpp\n${f.code}\n\`\`\`\n`)
      .join('');
    const snippet =
      `\n## ${OF_PROJECT_HEADING}\n\n` +
      `이 문서가 설명하는 앱을 만드는 openFrameworks(C++) 프로젝트 코드입니다. ` +
      `전체 프로젝트(src/ + 실행 방법) 압축파일: [${zipName}](/uploads/${encodeURIComponent(zipName)})\n\n` +
      `${sections}`;
    replaceSection(name, OF_PROJECT_HEADING, snippet);

    res.json({ ok: true, files, zipName });
  } catch (err) {
    console.error('[openframeworks-code] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Plain-text build note shipped inside the generated project zip - explains
// that the src/ tree drops straight into the project generator's default
// template, since a full openFrameworks install is way bigger than what a
// wiki should be hosting.
function ofProjectReadme(projectName, pageName) {
  return (
    `# ${projectName}\n\n` +
    `이 openFrameworks 프로젝트 코드는 위키 페이지 "*${pageName}*"의 내용을 바탕으로 AI가 생성한 것입니다.\n\n` +
    '## 실행 방법\n\n' +
    '1. openFrameworks(https://openframeworks.cc/download/)를 설치합니다.\n' +
    '2. 프로젝트 생성기(projectGenerator)로 빈 기본 프로젝트를 하나 만듭니다.\n' +
    '3. 이 압축파일의 src/ 폴더 안 main.cpp, ofApp.h, ofApp.cpp로, 새 프로젝트의 src/ 내용을 전부 교체합니다.\n' +
    '4. make 또는 IDE로 빌드한 뒤 실행합니다. (이 코드는 openFrameworks 핵심 API만 사용하므로 추가 애드온이 필요 없습니다.)\n\n' +
    '## 프로젝트 구조\n\n' +
    `    ${projectName}/\n` +
    '    ├── src/\n' +
    '    │   ├── main.cpp   - 앱 시작점 (ofSetupOpenGL + ofRunApp)\n' +
    '    │   ├── ofApp.h    - ofApp 클래스 선언\n' +
    '    │   └── ofApp.cpp  - setup/update/draw 구현\n' +
    '    └── README.md      - 이 파일\n'
  );
}

// Section heading for "Swift iOS 앱 코드 만들기" - same replace-on-rerun
// behavior as the openFrameworks feature above.
const SWIFT_PROJECT_HEADING = '🍎 Swift iOS 앱 코드';

// "Swift iOS 앱 코드 만들기": asks Ollama to write a complete SwiftUI iOS
// app - App.swift + ContentView.swift - for the app this page describes,
// zips both files plus a short build note into /uploads, and shows each
// generated file's code on the page. The zip is a bonus convenience, not the
// point: the code lives on the page itself, exactly like the openFrameworks
// button. Dropping the two files into a fresh Xcode "iOS App" template is
// all it takes to run, since the model is told to stick to Apple's own
// frameworks only.
app.post('/page/:name/swift-code', requireIndexAuth, async (req, res) => {
  try {
    const { name } = req.params;
    if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

    const { body } = wiki.readPage(name);
    const files = await ollama.generateSwiftCode(name, body.slice(0, 6000));

    // Page names are often Korean - collapse to a safe ASCII slug, and strip
    // leading/trailing '-' / '.' so the name can never be misread as a shell
    // or zip option flag.
    const projectName =
      (wiki.sanitizeName(name) || 'swift-app')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+/, '')
        .replace(/[-.]+$/, '') || 'swift-app';
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-swift-'));
    const projectRoot = path.join(workDir, projectName);
    let zipName = null;
    try {
      fs.mkdirSync(projectRoot, { recursive: true });
      for (const f of files) {
        // Filenames come straight from the model - refuse anything that would
        // escape the project root before it touches disk.
        const abs = path.resolve(projectRoot, f.filename);
        if (abs !== projectRoot && !abs.startsWith(projectRoot + path.sep)) continue;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.code.endsWith('\n') ? f.code : `${f.code}\n`);
      }
      fs.writeFileSync(path.join(projectRoot, 'README.md'), swiftProjectReadme(projectName, name));

      zipName = uniqueUploadFilename(`${projectName}-ios-app.zip`);
      execFileSync('zip', ['-r', '-q', path.join(UPLOAD_DIR, zipName), projectName], { cwd: workDir });
    } catch (err) {
      console.error('[swift-code] zip failed', err);
      throw new Error('앱 코드 압축 파일 생성에 실패했습니다.');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    const sections = files
      .map((f) => `### ${f.filename}\n\n\`\`\`swift\n${f.code}\n\`\`\`\n`)
      .join('');
    const snippet =
      `\n## ${SWIFT_PROJECT_HEADING}\n\n` +
      `이 문서가 설명하는 앱을 만드는 SwiftUI(iOS) 프로젝트 코드입니다. ` +
      `전체 프로젝트(파일 + 실행 방법) 압축파일: [${zipName}](/uploads/${encodeURIComponent(zipName)})\n\n` +
      `${sections}`;
    replaceSection(name, SWIFT_PROJECT_HEADING, snippet);

    res.json({ ok: true, files, zipName });
  } catch (err) {
    console.error('[swift-code] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Plain-text build note shipped inside the generated Swift project zip -
// explains that the two files drop straight into Xcode's "iOS App" template,
// since a full .xcodeproj (a plist-based binary bundle) is way bigger than
// what a wiki should be hosting.
function swiftProjectReadme(projectName, pageName) {
  return (
    `# ${projectName}\n\n` +
    `이 SwiftUI(iOS) 앱 코드는 위키 페이지 "*${pageName}*"의 내용을 바탕으로 AI가 생성한 것입니다.\n\n` +
    '## 실행 방법\n\n' +
    '1. Xcode를 열고 새 프로젝트(File > New > Project)에서 "iOS App" 템플릿을 선택합니다.\n' +
    '2. 이 압축파일 안 App.swift, ContentView.swift 두 파일을 프로젝트의 소스 폴더에 추가합니다 (기존에 있던 같은 이름의 파일은 교체).\n' +
    '3. 시뮬레이터 또는 실제 기기에서 빌드(Cmd+R)해 실행합니다. (Apple 시스템 프레임워크만 사용하므로 외부 패키지가 필요 없습니다.)\n\n' +
    '## 프로젝트 구조\n\n' +
    `    ${projectName}/\n` +
    '    ├── App.swift        - @main 앱 진입점 (WindowGroup + ContentView)\n' +
    '    ├── ContentView.swift- 메인 화면(뷰) 전체 구현\n' +
    '    └── README.md        - 이 파일\n'
  );
}

// Shared by /make-video and /make-shorts: locates the page's linked audio +
// PDF, renders the PDF to page images, and reads the audio duration. Caller
// is responsible for removing the returned workDir.
async function prepareSlideSource(name) {
  const { body } = wiki.readPage(name);
  const { audio, pdf } = video.findAudioAndPdf(body, UPLOAD_DIR);
  if (!audio || !pdf) {
    const err = new Error('이 문서에서 오디오 파일과 PDF 파일을 모두 찾지 못했습니다. 두 파일을 먼저 업로드해서 문서에 링크해주세요.');
    err.status = 400;
    throw err;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-video-'));
  const [duration, images, pdfTextContent] = await Promise.all([
    video.getAudioDuration(audio.abs),
    video.pdfToImages(pdf.abs, workDir),
    video.pdfText(pdf.abs),
  ]);
  if (!images.length) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw new Error('PDF에서 이미지를 추출하지 못했습니다.');
  }

  return { body, audio, pdf, workDir, duration, images, pdfTextContent };
}

function appendToPage(name, snippet) {
  const current = wiki.readPage(name).body;
  wiki.writePage(name, `${current.replace(/\s+$/, '')}\n${snippet}`);
}

// Like appendToPage, but first strips any previous "## <headingText>"
// section (up to the next "## " heading or end of file) before appending
// the new one - for features meant to be re-run repeatedly (like "주피터
// 노트북으로 변경"), where appendToPage's plain accumulation would otherwise
// pile up a duplicate section on every click.
function replaceSection(name, headingText, snippet) {
  const current = wiki.readPage(name).body;
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRe = new RegExp(`\\n##\\s+${escaped}[\\s\\S]*?(?=\\n##\\s|$)`, 'u');
  const withoutOld = current.replace(sectionRe, '');
  wiki.writePage(name, `${withoutOld.replace(/\s+$/, '')}\n${snippet}`);
}

// "유튜브 영상 만들기": if the page links to an uploaded audio file and an
// uploaded PDF, renders the PDF's pages as an equal-time slideshow muxed with
// the audio, asks Ollama for a title/description, and appends both to the page.
app.post('/page/:name/make-video', requireIndexAuth, async (req, res) => {
  const { name } = req.params;
  if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

  let source;
  try {
    source = await prepareSlideSource(name);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  try {
    const { body, audio, duration, images, pdfTextContent } = source;
    const outFilename = `${wiki.sanitizeName(name)}-youtube-${Date.now()}.mp4`;
    const outPath = path.join(UPLOAD_DIR, outFilename);
    await video.buildSlideshow({ images, audioPath: audio.abs, duration, outPath });

    const meta = await ollama.generateYoutubeMeta(name, `${body}\n\n${pdfTextContent}`.slice(0, 6000));
    const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

    // Single `*` is this wiki's wikilink syntax, so plain "- label: value"
    // list lines are used here instead of `**bold**` (unsupported, and would
    // misparse as a link). Each value is flattened to one line since list
    // items don't continue across newlines.
    const snippet =
      `\n## 🎬 유튜브 영상\n\n` +
      `[${outFilename}](/uploads/${encodeURIComponent(outFilename)})\n\n` +
      `- 제목: ${oneLine(meta.title)}\n` +
      `- 설명: ${oneLine(meta.description)}\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, videoUrl: `/uploads/${encodeURIComponent(outFilename)}`, title: meta.title, description: meta.description });
  } catch (err) {
    console.error('[make-video] error', err);
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(source.workDir, { recursive: true, force: true });
  }
});

// "쇼츠 영상 만들기": same source (audio + PDF slideshow) as the YouTube
// video, but cropped to the first 3 minutes and rendered in a black-background
// portrait (1080x1920) frame for YouTube Shorts.
app.post('/page/:name/make-shorts', requireIndexAuth, async (req, res) => {
  const { name } = req.params;
  if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

  let source;
  try {
    source = await prepareSlideSource(name);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  try {
    const { audio, duration, images } = source;
    const outFilename = `${wiki.sanitizeName(name)}-shorts-${Date.now()}.mp4`;
    const outPath = path.join(UPLOAD_DIR, outFilename);
    await video.buildSlideshow({
      images,
      audioPath: audio.abs,
      duration,
      outPath,
      width: 1080,
      height: 1920,
      maxDuration: SHORTS_MAX_SECONDS,
    });

    const snippet = `\n## 📱 쇼츠 영상\n\n[${outFilename}](/uploads/${encodeURIComponent(outFilename)})\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, videoUrl: `/uploads/${encodeURIComponent(outFilename)}` });
  } catch (err) {
    console.error('[make-shorts] error', err);
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(source.workDir, { recursive: true, force: true });
  }
});

// "배경음악 넣기": if the page links to an uploaded silent video (no audio
// track), asks Ollama for an English music-style description of the page's
// content, generates a matching instrumental clip locally with MusicGen
// (lib/musicgen.js, running in tts_env), loops/trims it to the video's own
// length (lib/video.js's muxLoopedAudio), and appends the result as a new
// mp4 to the page.
app.post('/page/:name/add-bgm', requireIndexAuth, async (req, res) => {
  const { name } = req.params;
  if (!wiki.pageExists(name)) return res.status(404).json({ error: 'page not found' });

  const { body } = wiki.readPage(name);
  const vid = video.findVideo(body, UPLOAD_DIR);
  if (!vid) {
    return res
      .status(400)
      .json({ error: '이 문서에서 첨부된 동영상을 찾지 못했습니다. 소리 없는 동영상을 먼저 업로드해서 문서에 링크해주세요.' });
  }

  let workDir;
  try {
    if (await video.hasAudioStream(vid.abs)) {
      return res.status(400).json({ error: '이 동영상에는 이미 오디오 트랙이 있습니다. 소리 없는 동영상만 지원합니다.' });
    }

    const duration = await video.getAudioDuration(vid.abs);
    const musicPrompt = await ollama.generateMusicStylePrompt(name, body.slice(0, 4000));

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2s-bgm-'));
    const musicPath = path.join(workDir, 'music.wav');
    await musicgen.generateMusic({ prompt: musicPrompt, duration, outPath: musicPath });

    const outFilename = `${wiki.sanitizeName(name)}-bgm-${Date.now()}.mp4`;
    const outPath = path.join(UPLOAD_DIR, outFilename);
    await video.muxLoopedAudio({ videoPath: vid.abs, audioPath: musicPath, outPath });

    const snippet =
      `\n## \u{1F3B5} 배경음악 추가된 영상\n\n` +
      `[${outFilename}](/uploads/${encodeURIComponent(outFilename)})\n\n` +
      `- 음악 스타일: ${musicPrompt.replace(/\s+/g, ' ').trim()}\n`;
    appendToPage(name, snippet);

    res.json({ ok: true, videoUrl: `/uploads/${encodeURIComponent(outFilename)}`, musicPrompt });
  } catch (err) {
    console.error('[add-bgm] error', err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
});

app.get('/new/:name', (req, res) => {
  const { name } = req.params;
  wiki.createEmptyPage(name);
  res.redirect(`/page/${encodeURIComponent(name)}/edit`);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).send(`<pre>${err.message}</pre>`);
});

app.listen(PORT, () => {
  console.log(`Squeak-style wiki running at http://localhost:${PORT}`);
  console.log(`Vault: ${wiki.VAULT_DIR}`);
});
