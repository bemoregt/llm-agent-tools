const fs = require('fs');
const path = require('path');
const hljs = require('highlight.js/lib/core');
hljs.registerLanguage('python', require('highlight.js/lib/languages/python'));
hljs.registerLanguage('cpp', require('highlight.js/lib/languages/cpp'));
hljs.registerLanguage('swift', require('highlight.js/lib/languages/swift'));
hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'));
hljs.registerLanguage('xml', require('highlight.js/lib/languages/xml'));
const notebook = require('./notebook');
const crypto = require('crypto');
const vrml = require('./vrml');

const VAULT_DIR = process.env.VAULT_PATH
  ? path.resolve(process.env.VAULT_PATH)
  : path.join(process.env.HOME, 'Documents', 'Jungok_Stone');

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Page names come from Express route params, which are already URL-decoded.
// Reject anything that could escape the vault directory.
function sanitizeName(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..' || base.includes('/') || base.includes('\\')) {
    throw new Error(`Invalid page name: ${name}`);
  }
  return base;
}

function filePath(name) {
  return path.join(VAULT_DIR, sanitizeName(name) + '.md');
}

function listPages() {
  return fs
    .readdirSync(VAULT_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.slice(0, -3))
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

function listPagesWithMtime() {
  return fs
    .readdirSync(VAULT_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => {
      const stat = fs.statSync(path.join(VAULT_DIR, e.name));
      return { name: e.name.slice(0, -3), mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function pageExists(name) {
  try {
    return fs.existsSync(filePath(name));
  } catch {
    return false;
  }
}

function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) return { frontmatter: m[0], body: raw.slice(m[0].length) };
  return { frontmatter: '', body: raw };
}

function readPage(name) {
  const raw = fs.readFileSync(filePath(name), 'utf8');
  return splitFrontmatter(raw);
}

function writePage(name, body) {
  let frontmatter = '';
  if (pageExists(name)) {
    frontmatter = splitFrontmatter(fs.readFileSync(filePath(name), 'utf8')).frontmatter;
  }
  fs.writeFileSync(filePath(name), frontmatter + body, 'utf8');
}

// Bookmark-style pages start with a pinned block (e.g. the "메일" section)
// followed by a `__` hr divider and then a pile of `- 이름: *url*` entries.
// This keeps the pinned block untouched and flattens everything after the
// divider into a single list sorted by click count, most-clicked first.
function reorderBookmarksByClicks(name, clickCounts) {
  const { body } = readPage(name);
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  const hrIdx = lines.findIndex((l) => /^_{2,}$/.test(l.trim()));
  if (hrIdx === -1) return { reordered: 0 };

  const pinned = lines.slice(0, hrIdx + 1);
  const rest = lines.slice(hrIdx + 1);

  const urlRe = /\*(https?:\/\/[^*\n]+)\*/;
  const items = rest
    .filter((l) => /^-+\s+\S/.test(l))
    .map((text) => {
      const m = text.match(urlRe);
      const url = m ? m[1] : null;
      return { text, count: url ? clickCounts[url] || 0 : 0 };
    });

  items.sort((a, b) => b.count - a.count);

  const newBody = `${pinned.join('\n')}\n${items.map((i) => i.text).join('\n')}\n`;
  writePage(name, newBody);
  return { reordered: items.length };
}

// Updates every *OldName* wiki-link in every other page to *NewName*, so
// renaming a page doesn't leave the rest of the wiki pointing at a name that
// no longer exists.
function updateLinksToRenamedPage(oldName, newName) {
  const pattern = new RegExp(`\\*${escapeRegExp(oldName)}\\*`, 'g');
  for (const pageName of listPages()) {
    const fp = filePath(pageName);
    const raw = fs.readFileSync(fp, 'utf8');
    if (!pattern.test(raw)) continue;
    pattern.lastIndex = 0;
    fs.writeFileSync(fp, raw.replace(pattern, `*${newName}*`), 'utf8');
  }
}

function renamePage(oldName, newName) {
  const oldPath = filePath(oldName);
  const newPath = filePath(newName);
  if (oldPath === newPath) return;
  if (!fs.existsSync(oldPath)) throw new Error(`Page not found: ${oldName}`);
  if (fs.existsSync(newPath)) throw new Error(`A page named "${newName}" already exists`);
  fs.renameSync(oldPath, newPath);
  updateLinksToRenamedPage(oldName, newName);
}

function createEmptyPage(name) {
  if (pageExists(name)) return;
  fs.writeFileSync(filePath(name), '', 'utf8');
}

// --- Squeak-style simple-tag rendering ---
// Convention for this wiki (distinct from standard Markdown):
//   *Some Page*     -> wiki link; creates the page on click if it doesn't exist yet
//   !text!          -> emphasis (italic)
//   `code`          -> inline code (Python-highlighted); <code>code</code> also works
//   ```             -> fenced code block, e.g. ```python ... ``` (defaults to python)
//   <code>          -> same as ```, if <code> and </code> each sit alone on their own line
//   # / ## / ###    -> headings (line must start with it)
//   - item          -> bullet list item (line must start with it)
//   -- / --- / ---- item -> nested bullet, one/two/three levels deeper
//   <calendar>      -> swiki-style calendar; each day links to its YYYY-MM-DD page
//   ![alt](url)     -> uploaded image, shown inline
//   [name](url)     -> uploaded file, shown as a download link
//   blank line      -> paragraph break, single newline -> <br>

function highlightCode(code, lang) {
  const language = lang && hljs.getLanguage(lang) ? lang : 'python';
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthWeeks(year, month) {
  const startDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = new Array(startDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function renderCalendar(yearMonthStr, existingPages, topic) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  if (yearMonthStr && /^\d{4}-\d{2}$/.test(yearMonthStr)) {
    const [y, m] = yearMonthStr.split('-').map(Number);
    year = y;
    month = m - 1;
  }
  const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const prev = new Date(year, month - 1, 1);
  const next = new Date(year, month + 1, 1);
  const prevYm = `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}`;
  const nextYm = `${next.getFullYear()}-${pad2(next.getMonth() + 1)}`;
  const topicParam = topic ? `:${encodeURIComponent(topic)}` : '';

  let html = '<table class="calendar">\n';
  html += `<caption><a class="cal-nav" href="?cal=${prevYm}${topicParam}">&laquo;</a> ${year}년 ${month + 1}월${topic ? ` · ${escapeHtml(topic)}` : ''} <a class="cal-nav" href="?cal=${nextYm}${topicParam}">&raquo;</a></caption>\n`;
  html += '<thead><tr><th>일</th><th>월</th><th>화</th><th>수</th><th>목</th><th>금</th><th>토</th></tr></thead>\n<tbody>\n';
  for (const week of monthWeeks(year, month)) {
    html += '<tr>';
    for (const day of week) {
      if (day === null) {
        html += '<td></td>';
        continue;
      }
      const dateStr = `${year}-${pad2(month + 1)}-${pad2(day)}`;
      const pageName = topic ? `${dateStr}:${topic}` : dateStr;
      const exists = existingPages.has(pageName);
      const classes = ['cal-day'];
      if (dateStr === todayStr) classes.push('cal-today');
      if (exists) classes.push('cal-exists');
      const href = `/${exists ? 'page' : 'new'}/${encodeURIComponent(pageName)}`;
      html += `<td class="${classes.join(' ')}"><a href="${href}">${day}</a></td>`;
    }
    html += '</tr>\n';
  }
  html += '</tbody>\n</table>\n';
  return html;
}

// Wrap runs of Latin-alphabet "foreign" words (e.g. English) in a colored
// span, without touching HTML tags or the @@TOKEN#@@ placeholders used
// elsewhere in this file.
function wrapForeignWordsInText(text) {
  return text.replace(/@@[A-Z]+\d+@@|&[a-zA-Z]+;|&#\d+;|[A-Za-z][A-Za-z0-9'-]*/g, (m) =>
    m.startsWith('@@') || m.startsWith('&') ? m : `<span class="foreign-word">${m}</span>`
  );
}

function highlightForeignWords(html) {
  return html
    .split(/(<[^>]*>)/g)
    .map((part, i) => (i % 2 === 1 ? part : wrapForeignWordsInText(part)))
    .join('');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wraps the first raw occurrence of each term in *term* wiki-link syntax,
// skipping fenced code blocks and inline `code` spans so it never touches
// code, and skipping anything already inside a *link*. Used by the
// "glossary" feature to turn highlighted foreign words into real links.
function linkTermsInBody(body, terms) {
  const sortedTerms = [...new Set(terms)].sort((a, b) => b.length - a.length);
  const linked = new Set();
  let inCode = false;
  let codeFlavor = null;

  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const outLines = lines.map((line) => {
    if (inCode) {
      const closing =
        codeFlavor === 'tag'
          ? /^<\/code>\s*$/i.test(line.trim()) || /^<code>\s*$/i.test(line.trim())
          : /^```\s*$/.test(line.trim());
      if (closing) {
        inCode = false;
        codeFlavor = null;
      }
      return line;
    }
    if (/^```\s*([\w+-]*)\s*$/.test(line)) {
      inCode = true;
      codeFlavor = 'fence';
      return line;
    }
    if (/^<code>\s*$/i.test(line.trim())) {
      inCode = true;
      codeFlavor = 'tag';
      return line;
    }

    return line
      .split(/(`[^`\n]*`)/g)
      .map((segment, i) => {
        if (i % 2 === 1) return segment; // inline code span, leave untouched
        let out = segment;
        for (const term of sortedTerms) {
          if (linked.has(term)) continue;
          const re = new RegExp(`(?<!\\*)\\b${escapeRegExp(term)}\\b(?!\\*)`);
          if (re.test(out)) {
            out = out.replace(re, `*${term}*`);
            linked.add(term);
          }
        }
        return out;
      })
      .join('');
  });

  return { body: outLines.join('\n'), linkedTerms: [...linked] };
}

// Placeholder markers used while shuffling tokens (links, code) through the
// escaping/formatting passes below. Plain text won't realistically contain
// these, so a naive string search-and-replace is safe.
function inline(rawText, existingPages) {
  // Keep both the raw code text (for building hrefs/exists-checks) and its
  // highlighted HTML (for display) - a link name that happens to contain a
  // code span must not have "@@CODE0@@" leak into the URL.
  const codeTokens = [];
  const resolveCode = (text, useHtml) =>
    text.replace(/@@CODE(\d+)@@/g, (_, idx) => {
      const tok = codeTokens[Number(idx)];
      return useHtml ? tok.html : tok.raw;
    });

  // Uploaded images/files: ![alt](url) shows an <img>, [label](url) is a download link.
  const imgTokens = [];
  let out = rawText.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_, alt, url) => {
    const idx = imgTokens.length;
    imgTokens.push(`<img class="wiki-img" src="${escapeHtml(url.trim())}" alt="${escapeHtml(alt.trim())}">`);
    return `@@IMG${idx}@@`;
  });

  const fileTokens = [];
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, label, url) => {
    const idx = fileTokens.length;
    const trimmedUrl = url.trim();
    const cleanUrl = escapeHtml(trimmedUrl);
    // An absolute http(s) URL is a plain external link, not an uploaded file -
    // uploaded files are always referenced by a relative /uploads/... path, so
    // this can't collide with the download-link behavior below.
    if (/^https?:\/\//i.test(trimmedUrl)) {
      fileTokens.push(
        `<a class="external-link" href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(label.trim())}</a>`
      );
    } else if (/^file:\/\//i.test(trimmedUrl)) {
      // A local hard-drive path, e.g. [내 프로젝트](file:///Users/air/Music/...).
      // Clicking it doesn't navigate anywhere - client JS (finderlink.js)
      // intercepts the click and POSTs the path to /open-in-finder, which
      // shells out to `open` so macOS Finder opens that exact path.
      const localPath = decodeURIComponent(trimmedUrl.replace(/^file:\/\//i, ''));
      fileTokens.push(
        `<a class="finder-link" href="#" data-path="${escapeHtml(localPath)}" title="${escapeHtml(localPath)}">\u{1F4C1} ${escapeHtml(label.trim())}</a>`
      );
    } else if (/\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(url)) {
      fileTokens.push(`<audio class="wiki-audio" controls src="${cleanUrl}"></audio>`);
    } else if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(url)) {
      // <video controls> alone doesn't give every browser a visible download
      // affordance (Safari/Firefox don't expose one in the control bar), so
      // pair it with the same explicit download link other file types get.
      fileTokens.push(
        `<video class="wiki-video" controls src="${cleanUrl}"></video>` +
        `<a class="file-link" href="${cleanUrl}" download>\u{1F4E5} ${escapeHtml(label.trim())} 다운로드</a>`
      );
    } else if (/\.pdf$/i.test(url)) {
      // No `download` attribute: left-click opens the browser's built-in PDF
      // viewer in a new tab; right-click still offers "Save Link As".
      fileTokens.push(
        `<a class="file-link" href="${cleanUrl}" target="_blank" rel="noopener noreferrer">\u{1F4C4} ${escapeHtml(label.trim())}</a>`
      );
    } else if (/\.ipynb$/i.test(url)) {
      // Rendered inline as an actual Jupyter-style cell view (read-only -
      // whatever outputs the notebook file already has, from the "주피터
      // 노트북으로 변경" feature's real execution) instead of just a
      // download link, plus the download link itself for opening in a real
      // Jupyter/VS Code.
      const match = trimmedUrl.match(/^\/uploads\/(.+)$/);
      let viewerHtml = '';
      if (match) {
        try {
          const abs = path.join(VAULT_DIR, '_uploads', decodeURIComponent(match[1]));
          const nb = JSON.parse(fs.readFileSync(abs, 'utf8'));
          viewerHtml = notebook.renderNotebookHtml(nb);
        } catch {
          viewerHtml = '<p class="side-hint">노트북을 읽지 못했습니다.</p>';
        }
      }
      fileTokens.push(
        `${viewerHtml}<a class="file-link" href="${cleanUrl}" download>\u{1F4CE} ${escapeHtml(label.trim())} (.ipynb 다운로드)</a>`
      );
    } else if (/-viewer\.html$/i.test(url)) {
      // "VRML 만들기"의 독립 실행 뷰어(.wrl과 짝을 이루는 -viewer.html, 이미
      // 100vh 전체화면 스타일로 생성됨 - lib/vrml.js의 generateViewerDocument):
      // download 속성 없이 새 탭으로 열어서, 클릭하면 그 탭이 화면을 가득 채운
      // VRML 그래픽 자체가 되도록 한다.
      fileTokens.push(
        `<a class="file-link" href="${cleanUrl}" target="_blank" rel="noopener noreferrer">\u{1F9CA} ${escapeHtml(label.trim())} (새 탭에서 전체화면으로 보기)</a>`
      );
    } else if (/\.wrl$/i.test(url)) {
      // "VRML 만들기": renders the same WebGL viewer (lib/vrml.js) live inline
      // instead of just linking the .wrl - regenerated fresh from the scene
      // JSON comment embedded in the file on every render, so it never goes
      // stale relative to the saved source.
      const match = trimmedUrl.match(/^\/uploads\/(.+)$/);
      let viewerHtml = '';
      if (match) {
        try {
          const abs = path.join(VAULT_DIR, '_uploads', decodeURIComponent(match[1]));
          const scene = vrml.parseSceneFromWrl(fs.readFileSync(abs, 'utf8'));
          if (scene) {
            const uid = 'vrml-' + crypto.randomBytes(4).toString('hex');
            viewerHtml = vrml.generateViewerFragment(scene, uid);
          } else {
            viewerHtml = '<p class="side-hint">VRML 장면 정보를 찾지 못했습니다.</p>';
          }
        } catch {
          viewerHtml = '<p class="side-hint">VRML 장면을 읽지 못했습니다.</p>';
        }
      }
      fileTokens.push(
        `${viewerHtml}<a class="file-link" href="${cleanUrl}" download>\u{1F4CE} ${escapeHtml(label.trim())} (.wrl 다운로드)</a>`
      );
    } else {
      fileTokens.push(`<a class="file-link" href="${cleanUrl}" download>\u{1F4CE} ${escapeHtml(label.trim())}</a>`);
    }
    return `@@FILE${idx}@@`;
  });

  // Accept both `code` (backtick) and a literal <code>...</code> tag typed as
  // plain text - either way it becomes highlighted inline code.
  out = out.replace(/`([^`\n]+?)`|<code>([^<\n]*?)<\/code>/gi, (_, backtickCode, tagCode) => {
    const code = backtickCode !== undefined ? backtickCode : tagCode;
    const idx = codeTokens.length;
    codeTokens.push({ raw: code, html: `<code class="hljs-inline">${highlightCode(code, 'python')}</code>` });
    return `@@CODE${idx}@@`;
  });

  // Math: $$...$$ (display) and $...$ (inline), both LaTeX rendered
  // client-side by KaTeX. Pulled out into placeholders (like code spans
  // above) before the raw source hits escapeHtml/wikilink/foreign-word
  // processing below - otherwise every Latin-letter macro name and variable
  // in the LaTeX itself would get wrapped in foreign-word spans or misread
  // as a *link*, corrupting the source KaTeX needs to parse. $$ is matched
  // first so its pair of dollars is never mistaken for two separate $...$
  // delimiters. Both forms are single-line only - no multi-line block state
  // machine, unlike fenced code.
  // Neither delimiter may sit next to whitespace (Pandoc's own heuristic for
  // this exact ambiguity) - without it, an unrelated line mentioning two
  // dollar amounts, e.g. "커피는 $5, 점심은 $10 정도야", would have its "5,
  // 점심은 " swallowed as a bogus equation between the two currency signs.
  const mathTokens = [];
  out = out.replace(/\$\$(?!\s)([^\n]+?)(?<!\s)\$\$/g, (_, expr) => {
    const idx = mathTokens.length;
    mathTokens.push({ expr: expr.trim(), display: true });
    return `@@MATH${idx}@@`;
  });
  out = out.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_, expr) => {
    const idx = mathTokens.length;
    mathTokens.push({ expr: expr.trim(), display: false });
    return `@@MATH${idx}@@`;
  });

  // Quoted text ("...") is shown bold.
  const quoteTokens = [];
  out = out.replace(/"([^"\n]+)"/g, (_, inner) => {
    const idx = quoteTokens.length;
    quoteTokens.push(`<strong class="quoted-text">&quot;${escapeHtml(inner)}&quot;</strong>`);
    return `@@QUOTE${idx}@@`;
  });

  out = escapeHtml(out);

  const linkTokens = [];
  out = out.replace(/\*([^*\n]+?)\*/g, (_, name) => {
    const trimmed = name.trim();
    const plainName = resolveCode(trimmed, false);
    const displayName = resolveCode(trimmed, true);
    const idx = linkTokens.length;

    // A URL inside *...* is just a link to that address, not a wiki page name.
    if (/^https?:\/\/\S+$/i.test(plainName)) {
      linkTokens.push(
        `<a class="external-link" href="${plainName}" target="_blank" rel="noopener noreferrer">${displayName}</a>`
      );
      return `@@LINK${idx}@@`;
    }

    const exists = existingPages.has(plainName);
    const href = `/${exists ? 'page' : 'new'}/${encodeURIComponent(plainName)}`;
    const cls = exists ? 'wikilink' : 'wikilink-new';
    const label = exists ? displayName : displayName + '?';
    linkTokens.push(`<a class="${cls}" href="${href}">${label}</a>`);
    return `@@LINK${idx}@@`;
  });
  out = out.replace(/!([^!\n]+?)!/g, (_, em) => `<em>${em}</em>`);
  out = highlightForeignWords(out);
  out = out.replace(/@@LINK(\d+)@@/g, (_, idx) => linkTokens[Number(idx)]);
  out = resolveCode(out, true);
  out = out.replace(/@@IMG(\d+)@@/g, (_, idx) => imgTokens[Number(idx)]);
  out = out.replace(/@@FILE(\d+)@@/g, (_, idx) => fileTokens[Number(idx)]);
  out = out.replace(/@@QUOTE(\d+)@@/g, (_, idx) => quoteTokens[Number(idx)]);
  out = out.replace(/@@MATH(\d+)@@/g, (_, idx) => {
    const t = mathTokens[Number(idx)];
    const tag = t.display ? 'div' : 'span';
    const cls = t.display ? 'katex-block' : 'katex-inline';
    return `<${tag} class="${cls}" data-katex="${escapeHtml(t.expr)}"></${tag}>`;
  });
  return out;
}

// items: [{level: 0, text: '...'}, ...] where level comes from dash count - 1
// (- => 0, -- => 1, --- => 2, ---- => 3). Builds properly nested <ul>s.
function renderNestedList(items, existingPages) {
  let i = 0;
  const buildLevel = (floor) => {
    let out = '<ul>\n';
    while (i < items.length && items[i].level >= floor) {
      const item = items[i];
      i += 1;
      let li = inline(item.text, existingPages);
      if (i < items.length && items[i].level > floor) {
        li += `\n${buildLevel(items[i].level)}`;
      }
      out += `<li>${li}</li>\n`;
    }
    out += '</ul>\n';
    return out;
  };
  return buildLevel(0);
}

function renderBody(raw, existingPages, calOverride) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let paragraphBuf = [];
  let listBuf = [];
  let inCodeBlock = false;
  let codeBuf = [];
  let codeLang = 'python';
  let codeFlavor = null; // 'fence' (```) or 'tag' (<code> on its own line)

  const flushParagraph = () => {
    if (paragraphBuf.length) {
      html += `<p>${paragraphBuf.map((l) => inline(l, existingPages)).join('<br>\n')}</p>\n`;
      paragraphBuf = [];
    }
  };
  const flushList = () => {
    if (listBuf.length) {
      html += renderNestedList(listBuf, existingPages);
      listBuf = [];
    }
  };
  const flushCodeBlock = () => {
    // Mermaid diagrams are rendered client-side (mermaid.js scans for
    // `.mermaid` elements), so the raw diagram source is passed through
    // as plain escaped text instead of being syntax-highlighted.
    if (codeLang === 'mermaid') {
      html += `<pre class="mermaid">${escapeHtml(codeBuf.join('\n'))}</pre>\n`;
    } else {
      html += `<pre class="hljs"><code class="language-${codeLang}">${highlightCode(codeBuf.join('\n'), codeLang)}</code></pre>\n`;
    }
    codeBuf = [];
  };

  for (const line of lines) {
    if (inCodeBlock) {
      // Accept either </code> or a bare <code> line as the closer - people often
      // bookend a block with <code> on both ends and forget the closing slash.
      const closing =
        codeFlavor === 'tag'
          ? /^<\/code>\s*$/i.test(line.trim()) || /^<code>\s*$/i.test(line.trim())
          : /^```\s*$/.test(line.trim());
      if (closing) {
        flushCodeBlock();
        inCodeBlock = false;
        codeFlavor = null;
      } else {
        codeBuf.push(line);
      }
      continue;
    }

    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    const tagFenceOpen = /^<code>\s*$/i.test(line.trim());

    if (fence) {
      flushParagraph();
      flushList();
      inCodeBlock = true;
      codeFlavor = 'fence';
      codeLang = fence[1] || 'python';
      continue;
    }

    if (tagFenceOpen) {
      flushParagraph();
      flushList();
      inCodeBlock = true;
      codeFlavor = 'tag';
      codeLang = 'python';
      continue;
    }

    const calendarTag = line
      .trim()
      .match(/^<calendar(?::(\d{4}-\d{2}))?(?::([\p{L}\p{N}_\-\s]+))?>$/iu);
    const hrTag = /^_{2,}$/.test(line.trim());
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const listItem = line.match(/^(-+)\s+(.*)$/);
    if (hrTag) {
      flushParagraph();
      flushList();
      html += '<hr>\n';
    } else if (calendarTag) {
      flushParagraph();
      flushList();
      const overrideParts = calOverride ? String(calOverride).split(':') : [];
      const overrideYm = /^\d{4}-\d{2}$/.test(overrideParts[0] || '') ? overrideParts[0] : null;
      const overrideTopic = overrideParts[1] ? decodeURIComponent(overrideParts[1]) : null;
      const ym = overrideYm || calendarTag[1] || null;
      const topic = calendarTag[2] ? overrideTopic || calendarTag[2] : null;
      html += renderCalendar(ym, existingPages, topic);
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2], existingPages)}</h${level}>\n`;
    } else if (listItem) {
      flushParagraph();
      listBuf.push({ level: listItem[1].length - 1, text: listItem[2] });
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraphBuf.push(line);
    }
  }
  flushParagraph();
  flushList();
  if (inCodeBlock && codeBuf.length) flushCodeBlock();
  return html;
}

function render(name, calOverride) {
  const { body } = readPage(name);
  const existingPages = new Set(listPages());
  return renderBody(body, existingPages, calOverride);
}

// Pulls out the set of *page* names a body actually links to (skipping code
// blocks/spans and external http(s) links), used to build the graph view.
function extractLinkedPages(body, existingPages) {
  const linked = new Set();
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let inCode = false;
  let codeFlavor = null;

  for (const line of lines) {
    if (inCode) {
      const closing =
        codeFlavor === 'tag'
          ? /^<\/code>\s*$/i.test(line.trim()) || /^<code>\s*$/i.test(line.trim())
          : /^```\s*$/.test(line.trim());
      if (closing) {
        inCode = false;
        codeFlavor = null;
      }
      continue;
    }
    if (/^```\s*([\w+-]*)\s*$/.test(line)) {
      inCode = true;
      codeFlavor = 'fence';
      continue;
    }
    if (/^<code>\s*$/i.test(line.trim())) {
      inCode = true;
      codeFlavor = 'tag';
      continue;
    }

    const withoutInlineCode = line.replace(/`[^`\n]*`/g, ' ');
    const re = /\*([^*\n]+?)\*/g;
    let m;
    while ((m = re.exec(withoutInlineCode))) {
      const name = m[1].trim();
      if (/^https?:\/\/\S+$/i.test(name)) continue;
      if (existingPages.has(name)) linked.add(name);
    }
  }
  return linked;
}

// Shared by buildTree() and findRelatedPages(): every page's *link*
// references to every other page, made undirected (A links to B counts as a
// connection both ways) since both features care about "what's connected to
// what", not "what points at what".
function buildAdjacency() {
  const pages = listPages();
  const existingPages = new Set(pages);

  const adjacency = new Map(pages.map((p) => [p, new Set()]));
  for (const name of pages) {
    const { body } = readPage(name);
    for (const target of extractLinkedPages(body, existingPages)) {
      if (target === name) continue;
      adjacency.get(name).add(target);
      adjacency.get(target).add(name);
    }
  }
  return { pages, adjacency };
}

// Auto-generated calendar day pages (YYYY-MM-DD, optionally ":topic" for a
// topic calendar - see renderCalendar()/the <calendar> tag above) are real
// pages once visited, but they're just dozens of near-identical "8월 3일"
// entries - useless as 3D navigator buttons. buildTree() below excludes them.
const CALENDAR_PAGE_RE = /^\d{4}-\d{2}-\d{2}(:.+)?$/;

// Builds a simple TREE (not the full link graph) for the 3D navigator:
// starting from `rootName` (defaults to "index", else the most-linked page),
// a breadth-first walk over the undirected *link* adjacency picks exactly one
// parent per page - the page that first led to it - so every page ends up
// with a single path back to the root. Any page never reached this way (no
// link path to the root) is attached directly under the root, so nothing is
// left out of the navigator.
function buildTree(rootName) {
  const { pages: allPages, adjacency } = buildAdjacency();
  const existingPages = new Set(allPages);

  let root = rootName && existingPages.has(rootName) ? rootName : null;
  if (!root) {
    if (existingPages.has('index')) {
      root = 'index';
    } else {
      root = allPages.reduce(
        (best, p) => (adjacency.get(p).size > adjacency.get(best).size ? p : best),
        allPages[0]
      );
    }
  }

  const parentOf = new Map();
  const visited = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency.get(cur)) {
      if (visited.has(next)) continue;
      visited.add(next);
      parentOf.set(next, cur);
      queue.push(next);
    }
  }
  for (const p of allPages) {
    if (!visited.has(p)) parentOf.set(p, root);
  }

  // Calendar pages are dropped from the output, but a genuinely-written page
  // that happened to get parented under one (e.g. linked from that day's
  // diary entry) shouldn't vanish with it - it's reattached to the nearest
  // surviving ancestor instead.
  function nearestKeptAncestor(name) {
    let cur = parentOf.get(name);
    while (cur !== undefined && cur !== root && CALENDAR_PAGE_RE.test(cur)) {
      cur = parentOf.get(cur);
    }
    return cur === undefined ? root : cur;
  }

  // Built from parentOf's own insertion order (BFS discovery order for
  // reached pages, i.e. roughly "the order this page's links were first
  // mentioned" - see buildAdjacency()'s comment), not a re-sort of
  // `allPages`, so filtering out calendar pages doesn't also reshuffle
  // every remaining button into alphabetical order.
  const edges = [...parentOf.entries()]
    .filter(([child]) => !CALENDAR_PAGE_RE.test(child))
    .map(([child]) => ({ parent: nearestKeptAncestor(child), child }));
  const nodes = allPages.filter((p) => !CALENDAR_PAGE_RE.test(p)).map((id) => ({ id, label: id }));
  return { root, nodes, edges };
}

// Finds pages within `maxHops` link-distance of `pageName` in the same
// undirected *link* graph the 3D navigator uses, nearest first (a plain BFS
// visits everything at distance 1 before anything at distance 2, so the
// discovery order is already the right order - no separate sort needed).
// Only ever returns pages that genuinely exist and are genuinely connected -
// the "why related" explanation is left to the caller (Ollama), but the
// candidate list itself is real graph data, nothing invented.
function findRelatedPages(pageName, maxResults = 5, maxHops = 2) {
  const { adjacency } = buildAdjacency();
  if (!adjacency.has(pageName)) return [];

  const dist = new Map([[pageName, 0]]);
  const order = [];
  const queue = [pageName];
  while (queue.length) {
    const cur = queue.shift();
    const curDist = dist.get(cur);
    if (curDist >= maxHops) continue;
    for (const next of adjacency.get(cur)) {
      if (dist.has(next)) continue;
      dist.set(next, curDist + 1);
      order.push(next);
      queue.push(next);
    }
  }
  return order.slice(0, maxResults).map((id) => ({ id, distance: dist.get(id) }));
}

module.exports = {
  VAULT_DIR,
  listPages,
  listPagesWithMtime,
  pageExists,
  readPage,
  writePage,
  reorderBookmarksByClicks,
  renamePage,
  createEmptyPage,
  render,
  renderBody,
  linkTermsInBody,
  buildTree,
  findRelatedPages,
  sanitizeName,
  highlightCode,
};
