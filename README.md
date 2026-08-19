# Terminal-Based AI Agents - Installation & Usage Guide

> macOS 26.0 (Sequoia) | Apple Silicon (arm64) | 2026-08-20

## Environment

| Item | Value |
|------|-------|
| OS | macOS 26.0 (Build 25A5349a) |
| Arch | arm64 (Apple Silicon) |
| Python | 3.10.18 |
| Node.js | v26.7.0 |
| Homebrew | >=4.3.0 |

---

## Installed Agents Summary

### Pre-existing (Before This Session)

| Agent | Version | Install Method | Command |
|-------|---------|---------------|---------|
| **opencode** | 1.18.15 | Homebrew | `opencode` |
| **aichat** | 0.30.0 | Homebrew | `aichat` |
| **Claude Code** | 2.1.235 | Local bin | `claude` |
| **Codex CLI** | 0.144.3 | Homebrew | `codex` |
| **Gemini CLI** | 0.54.4 | Homebrew | `gemini` |
| **GitHub Copilot** | 1.0.70 | gh extension | `gh copilot` |

### Newly Installed (This Session)

| Agent | Version | Install Method | Command | Status |
|-------|---------|---------------|---------|--------|
| **aider** | 0.86.2 | pip | `aider` | Working |
| **gptme** | 0.33.0 | pip | `gptme` | Working |
| **open-interpreter** | 0.4.3 | pip | `interpreter` | Import error* |
| **shell-gpt** | 1.5.1 | pip | `sgpt` | Needs API key |
| **gpt-engineer** | 0.3.1 | pip | `gpt-engineer` | Needs venv |
| **mentat** | 1.0.19 | pip | `mentat` | Deprecated |
| **goose** | 1.46.0 | Binary | `goose` | Working |

> *open-interpreter: `litellm`/`openai` 버전 충돌로 Python 3.10에서 import 에러 발생.

---

## Usage Guide

### 1. opencode (v1.18.15)

대화형 터미널 AI IDE. 세션 관리, MCP 서버, 에이전트 지원.

```bash
# 대화형 TUI 시작
opencode

# 특정 메시지로 실행
opencode run "이 프로젝트 구조를 설명해줘"

# 세션 이어서하기
opencode --continue
opencode --session <session-id>

# 모델 지정
opencode -m anthropic/claude-sonnet-4-20250514

# 프로바이더 인증 관리
opencode providers

# 사용 가능한 모델 목록
opencode models

# 토큰 사용량 및 비용 통계
opencode stats

# 세션 내보내기/가져오기
opencode export
opencode import <file>

# 서버 모드
opencode serve
opencode web              # 웹 인터페이스로 시작

# MCP 서버 관리
opencode mcp

# GitHub PR 분석
opencode pr <number>

# 세션 관리
opencode session

# 디버그
opencode debug

# 업그레이드
opencode upgrade
```

---

### 2. aichat (v0.30.0)

범용 LLM CLI 도구. 다중 모델, RAG, 에이전트, 매크로 지원.

```bash
# 대화 시작
aichat

# 특정 모델로 대화
aichat -m gpt-4 "안녕"

# 시스템 프롬프트 지정
aichat --prompt "너는 전문 코딩 어시스턴트야" "이 코드 리뷰해줘"

# 역할(Role) 지정
aichat -r coding "Python 함수 만들어줘"

# 세션 시작/참여
aichat -s mysession
aichat -s mysession "이전 대화 이어서"

# 에이전트 시작
aichat -a myagent

# RAG 사용
aichat --rag myrag "문서에서 답변해줘"

# 명령어 자연어 실행
aichat -e "오늘 날씨 알려줘"

# 코드만 출력
aichat -c "Python hello world"

# 파일 포함
aichat -f main.py "이 코드 설명해줘"
aichat -f ./src "이 디렉토리 구조 설명해줘"

# 스트림 끄기
aichat -S "빠른 응답"

# 목록 조회
aichat --list-models
aichat --list-roles
aichat --list-sessions
aichat --list-agents
aichat --list-rags
aichat --list-macros

# 서버 모드 (API + WebAPP)
aichat --serve 0.0.0.0:8080

# 정보 표시
aichat --info

# 모델 동기화
aichat --sync-models
```

---

### 3. Claude Code (v2.1.235)

Anthropic의 공식 CLI 코딩 에이전트.

```bash
# 대화형 세션 시작
claude

# 비대화형(headless) 모드
claude -p "이 프로젝트 테스트 코드 작성해줘"

# 대화 이어서하기
claude --continue

# 특정 세션 이어서하기
claude --resume <session-id>

# 모델 지정
claude --model claude-sonnet-4-20250514

# 허용 도구 지정
claude --allowedTools "Bash(git *) Edit"

# 시스템 프롬프트 추가
claude --append-system-prompt "코드 리뷰 전문가처럼 행동해"

# 추가 디렉토리 허용
claude --add-dir ./lib ./utils

# 위험한 권한 스킵 (샌드박스 전용)
claude --dangerously-skip-permissions

# 에이전트 모드
claude --bg "백그라운드에서 린트 실행"

# MCP 설정
claude --mcp-config mcp.json

# 비밀 모드 (最小)
claude --bare

# 클라우드 세션
claude --cloud "description"
```

---

### 4. Codex CLI (v0.144.3)

OpenAI의 공식 코딩 CLI 에이전트.

```bash
# 대화형 시작
codex

# 프롬프트와 함께 실행
codex "이 함수 최적화해줘"

# 비대화형 실행
codex exec "lint 에러 고쳐줘"
codex e "리팩토링해줘"

# 코드 리뷰
codex review

# 이전 세션 이어서하기
codex resume
codex --last          # 가장 최근 세션

# 세션 포크
codex fork
codex fork --last

# 로그인/로그아웃
codex login
codex logout

# MCP 서버 관리
codex mcp

# 플러그인 관리
codex plugin

# 샌드박스에서 명령 실행
codex sandbox "pytest tests/"

# 설정 오버라이드
codex -c model="o3"
codex -c 'sandbox_permissions=["disk-full-read-access"]'

# 최신 diff 적용
codex apply

# 진단
codex doctor

# 업데이트
codex update
```

---

### 5. Gemini CLI (v0.54.4)

Google의 공식 Gemini CLI 에이전트.

```bash
# 대화형 시작
gemini

# 프롬프트 모드 (비대화형)
gemini -p "이 프로젝트 설명해줘"

# 대화형으로 프롬프트 실행 후 대화 모드 유지
gemini -i "테스트 코드 작성해줘"

# 모델 지정
gemini -m gemini-2.5-pro

# YOLO 모드 (모든 승인 자동)
gemini -y

# 승인 모드 설정
gemini --approval-mode auto_edit   # 편집 자동 승인
gemini --approval-mode yolo        # 모든 것 자동 승인
gemini --approval-mode plan        # 읽기 전용

# 세션 이어서하기
gemini --resume latest
gemini --resume 5

# 세션 목록
gemini --list-sessions

# 세션 삭제
gemini --delete-session 3

# Git 워크트리에서 시작
gemini -w my-feature

# 샌드박스 모드
gemini -s

# 확장 관리
gemini extensions list
gemini extensions install <ext>

# 스킬 관리
gemini skills list

# 훅 관리
gemini hooks list

# MCP 서버 관리
gemini mcp

# Gemma 로컬 모델
gemini gemma

# 출력 형식
gemini -o json "구조 분석해줘"
gemini -o stream-json "실시간 출력"

# 디버그 모드
gemini -d
```

---

### 6. GitHub Copilot CLI (v1.0.70)

GitHub Copilot의 쉘 통합.

```bash
# 대화형 시작
gh copilot

# 특정 명령어 도움말
gh copilot "git 브랜치를 어떻게 삭제해?"

# GitHub CLI와 함께 사용
gh copilot suggest "PR 생성하는 법"
```

---

### 7. aider (v0.86.2)

Git 기반 AI 페어 프로그래밍. 자동 git 커밋 생성.

```bash
# 현재 디렉토리에서 시작
aider

# 모델 지정
aider --model gpt-4o
aider --model anthropic/claude-sonnet-4-20250514
aider --model deepseek/deepseek-chat

# 특정 파일과 시작
aider main.py utils.py

# 아키텍트 모드 (설계 후 구현)
aider --architect

# 파일 없이 시작 (코드베이스 자동 분석)
aider --no-file

# git 자동 커밋 비활성화
aider --no-auto-commits

# 더티 커밋 (변경사항 커밋)
aider --dirty-commits

# 리트 린트 실행
aider --lint
aider --lint-cmd "ruff check"

# 테스트 실행
aider --test
aider --test-cmd "pytest tests/"

# 커밋 메시지 커스터마이즈
aider --commit "fix: improve performance"

# 파일 시스템 감시
aider --watch-files

# 특정 에디터 모델
aider --editor-model gpt-4o

# 히스토리 파일 지정
aider --input-history-file .aider.input.history

# 다크 모드
aider --dark-mode

# 아키텍트 자동 승인
aider --auto-accept-architect

# 설정 파일
aider --model-settings-file .aider.model.settings
```

---

### 8. gptme (v0.33.0)

터미널 기반 AI 비서. 파일 편집, 코드 실행, MCP 지원.

```bash
# 대화 시작
gptme

# 프롬프트로 시작
gptme "hello"

# 파일 포함하여 시작
gptme "fix TODOs" main.py

# GitHub PR 포함
gptme "review" github.com/org/repo/pull/1

# 도구 없이 (채팅만)
gptme --tools none "what is 2+2"

# 읽기 전용 도구만
gptme -t read-only "summarize this repo"

# 특정 도구만
gptme -t patch,save "fix typo" main.py

# 기본 도구 + 서브에이전트
gptme -t +subagent "plan a refactor"

# 브라우저 도구 제외
gptme -t=-browser "summarize code"

# 컨텍스트 커맨드 건너뛰기
gptme --context files "do task"

# 사용 가능한 도구 목록
# append, autocommit, autocompact, browser, chats, choice, clarify,
# complete, computer, elicit, form, gh, hashline_edit, ipython, lessons,
# mcp, patch, patch_anchored, patch_many, progress, read, restart, save,
# screenshot, shell, subagent, todo, vent, view_anchored, vision

# 대화 중 명령어
# /undo         - 마지막 작업 취소
# /backtrack    - 대화를 체크포인트로 되돌리기
# /log          - 대화 로그 표시
# /checkpoint   - 워크스페이스 체크포인트 관리
# /edit         - 에디터로 대화 편집
# /rename       - 대화 이름 변경
# /fork         - 대화 복사
# /delete       - 대화 삭제
# /summarize    - 대화 요약
# /replay       - 도구 작업 재실행
# /export       - HTML로 내보내기
# /model        - 현재 모델 표시/전환
# /models       - 사용 가능한 모델 목록
# /tokens       - 토큰 사용량 및 비용
# /context      - 컨텍스트 토큰 분석
# /tools        - 사용 가능한 도구 목록
# /commit       - git 커밋 요청
# /compact      - 대화 압축
# /impersonate  - 어시스턴트 흉내
# /plugin       - 플러그인 관리
# /doctor       - 시스템 진단
# /setup        - 설정
# /help         - 도움말
# /exit         - 종료
```

---

### 9. open-interpreter (v0.4.3)

자연어로 코드 실행. 로컬 인터프리터.

```bash
# 대화형 시작
interpreter

# 프롬프트 모드
interpreter -p "帮我写一个Python脚本"

# 현재 상태: litellm/openai 버전 충돌로 사용 불가
# 해결: 별도 가상 환경에서 설치 필요
```

---

### 10. shell-gpt (v1.5.1)

쉘에서 바로 GPT 사용.

```bash
# API 키 설정 (최초 1회)
sgpt --init

# 일반 질문
sgpt "what is the meaning of life?"

# 코드 생성
sgpt "python function to merge two sorted arrays"

# 쉘 명령어 생성
sgpt "find all files larger than 100MB"

# 설명 요청
sgpt --code "explain this pipeline: ls | grep py | wc -l"

# 역할 지정
sgpt --role "expert python developer" "write a decorator"

# 히스토리에서 이어서
sgpt --chat "continue from where we left off"

# 현재 상태: API 키 미설정 시 에러 발생
# 해결: `sgpt --init` 또는 OPENAI_API_KEY 환경 변수 설정
```

---

### 11. gpt-engineer (v0.3.1)

AI가 코드 베이스를 읽고 엔지니어링.

```bash
# 프롬프트 파일로 시작
gpt-engineer <prompt_file> [project_dir]

# 현재 상태: Python 가상 환경 필요
# pip install gpt-engineer 후 가상 환경에서 실행 권장
```

---

### 12. mentat (v1.0.19)

> ⚠️ Deprecated: 이 버전은 더 이상 유지보수되지 않음.

```bash
# 현재 상태: 더 이상 관리되지 않는 버전
# 대안: https://www.mentat.ai 방문
```

---

### 13. goose (v1.46.0)

Block(Square)의 범용 AI 에이전트. MCP 지원.

```bash
# 대화형 세션 시작
goose session
goose s                   # 별칭

# 설정
goose configure

# 정보 표시
goose info

# 진단
goose doctor

# MCP 서버 실행
goose mcp

# ACP 서버 모드
goose acp
goose serve               # HTTP/WebSocket 서버

# 파일에서 명령 실행
goose run instructions.md

# 파이프라인 입력
echo "explain this code" | goose run

# TUI 모드
goose tui

# 터미널 통합 세션
goose term

# 레시피 관리
goose recipe

# 스킬 관리
goose skills

# 플러그인 관리
goose plugin

# 예약 작업
goose schedule

# 게이트웨이 관리
goose gateway

# 로컬 모델 관리
goose local-models
goose lm

# 셸 자동완성 스크립트 생성
goose completion zsh > ~/.zfunc/_goose

# 버전 업데이트
goose update

# 현재 diff 리뷰
goose review
```

---

## API Key Setup

모든 에이전트를 사용하려면 다음 환경 변수 중 하나 이상을 설정해야 합니다:

```bash
# .zshrc 또는 .bashrc에 추가
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="..."
```

---

## Dependency Conflicts Note

pip 기반 에이전트 간 의존성 버전 충돌이 발생합니다. 각 에이전트를 별도의 Python 가상 환경에서 실행하는 것을 권장합니다:

```bash
# 예: aider용 가상 환경
python3 -m venv ~/envs/aider && source ~/envs/aider/bin/activate
pip install aider-chat

# 예: gptme용 가상 환경
python3 -m venv ~/envs/gptme && source ~/envs/gptme/bin/activate
pip install gptme

# 예: open-interpreter용 가상 환경
python3 -m venv ~/envs/oi && source ~/envs/oi/bin/activate
pip install open-interpreter
```

## Known Issues

| Agent | Issue | Solution |
|-------|-------|----------|
| open-interpreter | `litellm`/`openai` 버전 충돌 | 가상 환경 사용 또는 Python 3.11+ 업그레이드 |
| shell-gpt | API 키 미설정 시 에러 | `sgpt --init` 또는 환경 변수 설정 |
| gpt-engineer | 의존성 충돌 | 별도 가상 환경 사용 |
| mentat | Deprecated | https://www.mentat.ai 방문 |
