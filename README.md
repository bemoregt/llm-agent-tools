# Jungok Stone Wiki — Obsidian 기반 로컬 LLM 위키

Obsidian 볼트를 지식 저장소로 쓰고, 로컬 LLM(Ollama)과 RAG로 그 지식에 대해 질문/분석할 수 있게 만든 개인용 시스템입니다. 전부 로컬에서 동작하며 외부 API 키가 필요 없습니다.

## 구성 요소

| 구성 요소 | 역할 | 위치 |
|---|---|---|
| Obsidian | 노트 작성 (지식 원본) | `~/Documents/Jungok_Stone` |
| Ollama | 로컬 LLM 실행 (채팅 + 임베딩) | 시스템 서비스 |
| aichat | RAG 인덱싱 + 터미널/웹 채팅 | `~/Library/Application Support/aichat` |
| wiki_web_input.py | 지식 추가용 웹 폼 (텍스트/GitHub/PDF) | `~/scripts/wiki_web_input.py` |
| Quartz | 볼트를 읽기 전용 웹사이트로 발행 | `~/Documents/quartz` |

### 사용 중인 모델 (Ollama)

- **채팅**: `gemma4:cloud` — 이름과 달리 완전 로컬 모델(약 9GB, 비전+오디오 지원). Apple M1 GPU(Metal)로 추론.
- **임베딩**: `nomic-embed-text` (274MB, Nomic AI) — RAG용 벡터 임베딩 전용, 대화 불가.

## 지식 추가 방법

1. **Obsidian에서 직접 작성**: `~/Documents/Jungok_Stone`에 `.md` 파일 작성/수정
2. **웹 텍스트 입력**: `http://localhost:8091` — 제목/본문 입력 후 저장
3. **GitHub 저장소 분석**: 같은 페이지에서 저장소 URL 입력 → README + 핵심 소스 파일을 map-reduce로 분석해 노트 생성
4. **PDF 논문 업로드**: 같은 페이지에서 PDF 업로드 → `pdftotext`로 텍스트 추출 후 map-reduce로 분석해 노트 생성

Obsidian/웹 폼 외의 방법으로 노트를 추가/수정했다면 RAG 인덱스를 수동으로 갱신해야 합니다:

```sh
aichat --rag jungok-wiki --rebuild-rag
```

(웹 폼으로 추가한 경우는 자동으로 갱신됩니다.)

## 지식 질문하기 (채팅)

- **터미널**: `aichat --rag jungok-wiki "질문 내용"`
- **터미널 REPL**: `aichat` 실행 후 `.rag jungok-wiki` 입력
- **웹 플레이그라운드**: `http://localhost:8090/playground`

## 서비스 실행 (재부팅 후 필요)

이 시스템의 웹 서비스들은 백그라운드 프로세스로 떠 있으며, 재부팅하면 다시 실행해야 합니다.

```sh
# RAG 연동 채팅 웹 서버 (localhost:8090)
nohup aichat --serve 0.0.0.0:8090 --rag jungok-wiki > /tmp/aichat-serve.log 2>&1 &

# 지식 추가 웹 폼 (localhost:8091)
nohup python3 ~/scripts/wiki_web_input.py > /tmp/wiki-web-input.log 2>&1 &

# 읽기 전용 위키 사이트 (localhost:8080), 볼트 변경 시 자동 재빌드
cd ~/Documents/quartz && nohup npx quartz build --serve --watch > /tmp/quartz-serve.log 2>&1 &
```

인트라넷의 다른 기기에서는 이 Mac의 IP로 접속 가능합니다 (예: `http://192.168.0.57:8090`).

## 설정 파일

- aichat 설정: `~/Library/Application Support/aichat/config.yaml`
  - Ollama를 `openai-compatible` 클라이언트로 연결 (`http://localhost:11434/v1`)
  - 채팅/임베딩 모델 목록과 각 모델의 능력(embedding, vision 등) 명시 필요
- RAG 인덱스 데이터: `~/Library/Application Support/aichat/rags/jungok-wiki.yaml`

## 알아둘 점

- `gemma4:cloud`(로컬 LLM)의 실제 컨텍스트 창은 약 4096토큰으로 작아서, GitHub/PDF 분석 기능은 전체를 한 번에 넣지 않고 청크/파일 단위로 나눠 요약한 뒤 종합하는 map-reduce 방식을 씁니다.
- GitHub API는 비로그인 상태로 호출하므로 시간당 60회 제한이 있습니다.
- PDF는 텍스트 추출 기반이라 스캔본(이미지) PDF는 지원하지 않습니다 (OCR 없음).
