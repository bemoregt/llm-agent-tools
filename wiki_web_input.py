#!/usr/bin/env python3
import subprocess
import datetime
import re
import json
import base64
import tempfile
import os
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

VAULT_DIR = "/Users/air/Documents/Jungok_Stone"
RAG_NAME = "jungok-wiki"
CHAT_API = "http://localhost:8090/v1/chat/completions"
CHAT_MODEL = "ollama:gemma4:cloud"
MAX_TREE_ENTRIES = 200
MAX_KEY_FILES = 6
MAX_FILE_CHARS = 2500

CODE_EXTENSIONS = (
    ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".c", ".cpp",
    ".h", ".hpp", ".rb", ".php", ".sh", ".swift", ".kt", ".scala", ".cs",
)
SKIP_PATH_PARTS = (
    "test", "tests", "vendor", "node_modules", "dist", "build", ".github",
    "examples", "example", "third_party", "docs",
)

PDF_CHUNK_CHARS = 3000
MAX_PDF_CHUNKS = 12

PAGE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>지식 추가</title>
<style>
body {{ font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }}
input, textarea {{ width: 100%; font-size: 16px; padding: 8px; box-sizing: border-box; }}
textarea {{ height: 300px; margin-top: 8px; }}
button {{ margin-top: 12px; padding: 10px 20px; font-size: 16px; }}
.msg {{ padding: 10px; background: #e6ffed; border-radius: 6px; margin-bottom: 16px; white-space: pre-wrap; }}
.msg.err {{ background: #ffe6e6; }}
hr {{ margin: 32px 0; border: none; border-top: 1px solid #ddd; }}
h3 {{ margin-bottom: 4px; }}
.hint {{ color: #777; font-size: 13px; margin-top: 0; }}
</style></head>
<body>
<h2>정옥 스톤 위키 - 지식 추가</h2>
{message}
<form method="post" action="/">
<input name="title" placeholder="제목 (비우면 날짜/시간으로 자동 생성)">
<textarea name="content" placeholder="여기에 내용을 적으세요..." required></textarea>
<button type="submit">저장하고 색인 갱신</button>
</form>

<hr>

<h3>GitHub 저장소에서 가져오기</h3>
<p class="hint">README와 파일 구조를 가져와 로컬 LLM이 요약한 뒤 노트로 저장합니다.</p>
<form method="post" action="/github">
<input name="repo_url" placeholder="https://github.com/owner/repo" required>
<button type="submit">분석해서 추가</button>
</form>

<hr>

<h3>PDF 논문 업로드</h3>
<p class="hint">PDF에서 텍스트를 추출해 로컬 LLM이 분석한 뒤 노트로 저장합니다.</p>
<form method="post" action="/pdf" enctype="multipart/form-data">
<input type="file" name="pdf_file" accept="application/pdf" required>
<button type="submit">분석해서 추가</button>
</form>
</body></html>
"""


def slugify(title: str) -> str:
    title = title.strip()
    title = re.sub(r"[\\/:*?\"<>|]", "", title)
    return title or datetime.datetime.now().strftime("%Y-%m-%d %H%M%S")


def save_note(title: str, content: str) -> str:
    name = slugify(title)
    path = f"{VAULT_DIR}/{name}.md"
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return name


def rebuild_rag() -> tuple[bool, str]:
    result = subprocess.run(
        ["aichat", "--rag", RAG_NAME, "--rebuild-rag"],
        capture_output=True, text=True,
    )
    return result.returncode == 0, result.stderr[:300]


def github_api(path: str):
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "jungok-wiki"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def chat_llm(prompt: str, timeout: int = 300) -> str:
    payload = json.dumps({
        "model": CHAT_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        CHAT_API, data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return result["choices"][0]["message"]["content"]


def select_key_files(tree_items: list) -> list:
    candidates = []
    for item in tree_items:
        if item.get("type") != "blob":
            continue
        path = item["path"]
        lower = path.lower()
        if not lower.endswith(CODE_EXTENSIONS):
            continue
        if any(part in lower.split("/") for part in SKIP_PATH_PARTS):
            continue
        candidates.append((path, item.get("size", 0)))

    def score(entry):
        path, size = entry
        depth = path.count("/")
        name = path.rsplit("/", 1)[-1].lower()
        is_entry_name = any(
            name.startswith(n) for n in ("main.", "index.", "app.", "cli.", "server.")
        )
        return (0 if is_entry_name else 1, depth, -size)

    candidates.sort(key=score)
    return [path for path, _ in candidates[:MAX_KEY_FILES]]


def fetch_raw_file(owner: str, repo: str, branch: str, path: str) -> str:
    url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "jungok-wiki"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def parse_multipart(body: bytes, boundary: str) -> dict:
    """Minimal multipart/form-data parser (Python 3.13 removed the cgi module)."""
    delimiter = b"--" + boundary.encode()
    fields = {}
    for part in body.split(delimiter):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        headers_raw = part[:header_end].decode("utf-8", errors="ignore")
        content = part[header_end + 4:].rstrip(b"\r\n")
        name_match = re.search(r'name="([^"]*)"', headers_raw)
        if not name_match:
            continue
        filename_match = re.search(r'filename="([^"]*)"', headers_raw)
        filename = filename_match.group(1) if filename_match else None
        fields[name_match.group(1)] = (content, filename)
    return fields


def extract_pdf_text(pdf_bytes: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name
    try:
        result = subprocess.run(
            ["pdftotext", "-layout", tmp_path, "-"],
            capture_output=True, timeout=60,
        )
        return result.stdout.decode("utf-8", errors="ignore")
    finally:
        os.unlink(tmp_path)


def chunk_text(text: str, chunk_size: int = PDF_CHUNK_CHARS, max_chunks: int = MAX_PDF_CHUNKS) -> list:
    chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size) if text[i:i + chunk_size].strip()]
    if len(chunks) <= max_chunks:
        return chunks
    # 논문은 앞부분(서론/초록)과 뒷부분(결론)이 중요하므로 양 끝을 우선 포함
    head_n = max_chunks * 2 // 3
    tail_n = max_chunks - head_n
    return chunks[:head_n] + chunks[-tail_n:]


def fetch_pdf_knowledge(pdf_bytes: bytes, filename: str) -> tuple[str, str]:
    """Returns (title, markdown_content) for the analyzed PDF paper."""
    text = extract_pdf_text(pdf_bytes)
    if not text.strip():
        raise ValueError("PDF에서 텍스트를 추출하지 못했습니다 (스캔본 이미지일 수 있음).")

    chunks = chunk_text(text)

    # 1단계: 각 청크를 개별 요약 (map)
    chunk_summaries = []
    for i, chunk in enumerate(chunks):
        prompt = (
            f"다음은 한 학술 논문의 일부(순서상 {i + 1}/{len(chunks)}번째 조각)입니다. "
            f"핵심 내용을 3~5문장으로 한국어로 요약해줘.\n\n{chunk}"
        )
        try:
            summary = chat_llm(prompt, timeout=120)
            chunk_summaries.append(f"[조각 {i + 1}] {summary}")
        except (urllib.error.URLError, TimeoutError):
            continue

    if not chunk_summaries:
        raise ValueError("논문 내용을 분석하지 못했습니다.")

    summaries_text = "\n\n".join(chunk_summaries)

    # 2단계: 전체 종합 (reduce)
    prompt = f"""다음은 한 학술 논문을 여러 부분으로 나눠 각각 요약한 내용입니다.
이를 종합해서 한국어 위키 노트를 작성해줘. 아래 순서로 정리해줘 (파악 가능한 항목만):
- 논문 제목/저자 (추정 가능하면)
- 연구 목적/문제
- 방법론
- 주요 결과
- 결론/의의
마크다운으로 작성해줘.

파일명: {filename}

--- 부분별 요약 ---
{summaries_text}
"""
    summary = chat_llm(prompt, timeout=300)

    title = os.path.splitext(filename)[0] or "논문"
    frontmatter = f"---\nsource: PDF 업로드 ({filename})\nimported: {datetime.datetime.now().isoformat()}\n---\n\n"
    return title, frontmatter + summary


def parse_repo_url(url: str):
    m = re.search(r"github\.com/([^/]+)/([^/#?]+)", url.strip())
    if not m:
        return None
    owner, repo = m.group(1), m.group(2)
    repo = repo.removesuffix(".git")
    return owner, repo


def fetch_github_knowledge(repo_url: str) -> tuple[str, str]:
    """Returns (title, markdown_content) for the analyzed repo."""
    parsed = parse_repo_url(repo_url)
    if not parsed:
        raise ValueError("올바른 GitHub 저장소 URL이 아닙니다.")
    owner, repo = parsed

    meta = github_api(f"/repos/{owner}/{repo}")
    default_branch = meta.get("default_branch", "main")
    description = meta.get("description") or "(설명 없음)"
    language = meta.get("language") or "(알 수 없음)"
    stars = meta.get("stargazers_count", 0)

    try:
        readme = github_api(f"/repos/{owner}/{repo}/readme")
        readme_text = base64.b64decode(readme["content"]).decode("utf-8", errors="ignore")
    except urllib.error.HTTPError:
        readme_text = "(README 없음)"

    tree_items = []
    try:
        tree = github_api(f"/repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1")
        tree_items = tree.get("tree", [])
        paths = [item["path"] for item in tree_items if item.get("type") == "blob"]
        truncated = len(paths) > MAX_TREE_ENTRIES
        paths = paths[:MAX_TREE_ENTRIES]
        tree_text = "\n".join(paths) + ("\n... (이하 생략)" if truncated else "")
    except urllib.error.HTTPError:
        tree_text = "(파일 목록을 가져오지 못함)"

    # 1단계: 핵심 소스 파일들을 골라 각각 개별 요약 (map)
    key_files = select_key_files(tree_items)
    file_summaries = []
    for path in key_files:
        try:
            raw = fetch_raw_file(owner, repo, default_branch, path)
        except urllib.error.HTTPError:
            continue
        snippet = raw[:MAX_FILE_CHARS]
        file_prompt = f"다음 소스 파일이 하는 역할을 2~3문장으로 한국어로 요약해줘.\n\n파일 경로: {path}\n\n{snippet}"
        try:
            summary = chat_llm(file_prompt, timeout=120)
            file_summaries.append(f"### `{path}`\n{summary}")
        except (urllib.error.URLError, TimeoutError):
            continue

    files_section = "\n\n".join(file_summaries) if file_summaries else "(분석할 소스 파일을 찾지 못함)"

    # 2단계: README + 파일 구조 + 파일별 요약을 종합 (reduce)
    prompt = f"""다음은 GitHub 저장소 정보와, 그 안의 핵심 소스 파일들을 각각 분석한 요약입니다.
이를 종합해서 한국어 위키 노트를 작성해줘.
"이 프로젝트가 무엇을 하는지", "핵심 구조(주요 파일과 각각의 역할)", "사용법/설치법(README에 있다면)" 순서로 정리해줘. 마크다운으로 작성해줘.

저장소: {owner}/{repo}
설명: {description}
주요 언어: {language}
Star 수: {stars}

--- README ---
{readme_text[:4000]}

--- 전체 파일 구조 ---
{tree_text}

--- 핵심 파일별 분석 ---
{files_section}
"""

    summary = chat_llm(prompt, timeout=300)

    frontmatter = f"---\nsource: {repo_url}\nimported: {datetime.datetime.now().isoformat()}\n---\n\n"
    return repo, frontmatter + summary


class Handler(BaseHTTPRequestHandler):
    def _send_html(self, message="", is_err=False):
        cls = "msg err" if is_err else "msg"
        msg_html = f'<div class="{cls}">{message}</div>' if message else ""
        body = PAGE.format(message=msg_html).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send_html()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        content_type = self.headers.get("Content-Type", "")

        if self.path == "/pdf" and content_type.startswith("multipart/form-data"):
            boundary_match = re.search(r"boundary=(.+)", content_type)
            boundary = boundary_match.group(1).strip().strip('"') if boundary_match else ""
            body = self.rfile.read(length)
            parts = parse_multipart(body, boundary)
            file_content, filename = parts.get("pdf_file", (b"", None))
            if not filename or not file_content:
                self._send_html("PDF 파일이 첨부되지 않았습니다.", is_err=True)
                return
            try:
                title, content = fetch_pdf_knowledge(file_content, filename)
                name = save_note(title, content)
                ok, err = rebuild_rag()
                status = "색인 갱신 완료" if ok else f"색인 갱신 실패: {err}"
                self._send_html(f"저장됨: {name}.md — {status}")
            except Exception as e:
                self._send_html(f"분석 실패: {e}", is_err=True)
            return

        fields = parse_qs(self.rfile.read(length).decode("utf-8"))

        if self.path == "/github":
            repo_url = fields.get("repo_url", [""])[0]
            try:
                title, content = fetch_github_knowledge(repo_url)
                name = save_note(title, content)
                ok, err = rebuild_rag()
                status = "색인 갱신 완료" if ok else f"색인 갱신 실패: {err}"
                self._send_html(f"저장됨: {name}.md — {status}")
            except Exception as e:
                self._send_html(f"가져오기 실패: {e}", is_err=True)
            return

        title = fields.get("title", [""])[0]
        content = fields.get("content", [""])[0]
        if not content.strip():
            self._send_html("내용이 비어 있어 저장하지 않았습니다.", is_err=True)
            return
        name = save_note(title, content)
        ok, err = rebuild_rag()
        status = "색인 갱신 완료" if ok else f"색인 갱신 실패: {err}"
        self._send_html(f"저장됨: {name}.md — {status}")

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8091), Handler)
    print("지식 추가 폼: http://0.0.0.0:8091")
    server.serve_forever()
