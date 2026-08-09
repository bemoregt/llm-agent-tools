const { Agent, setGlobalDispatcher } = require('undici');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nemotron-3-ultra:cloud';

// Node's built-in fetch() (undici under the hood) aborts a request with
// UND_ERR_HEADERS_TIMEOUT if the server hasn't sent response headers within
// 300s by default. Every call here uses `stream: false`, so Ollama holds
// the connection open with no headers at all until the *entire* generation
// is done - for a big model on heavy multi-file prompts (openFrameworks/
// Swift code generation especially) that routinely exceeds 5 minutes, which
// surfaced as "[TypeError: fetch failed]" in the server log. Raising the
// dispatcher's timeouts fixes it; this is verified to actually take effect
// on the global fetch() (not just requests made through this Agent
// directly) since Node's fetch reads the dispatcher set here.
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }));

async function defineTerm(term) {
  const prompt =
    `"${term}"이라는 용어를 위키 문서에 넣을 짧은 설명으로 써줘. ` +
    '3~5문장 정도의 한국어 평문으로, 마크다운 기호(#, *, `, - 등) 없이 순수 텍스트로만 답해. ' +
    '이 위키는 딥러닝/컴퓨터비전 등 기술 문서가 많으니, 그 분야 용어라면 그 맥락으로 설명해줘.';

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  return (data.response || '').trim();
}

// Generates a YouTube title + description for a page's slideshow video, from
// the wiki page text and the attached PDF's extracted text.
// Generates an English text-to-music prompt (instruments/tempo/mood)
// describing the musical style suggested by a page's content, for the
// "배경음악 넣기" feature's MusicGen input (lib/musicgen.js) - MusicGen's
// text encoder was trained primarily on English descriptions, so this is
// requested in English even though the rest of this app's Ollama prompts
// are in Korean.
async function generateMusicStylePrompt(pageTitle, context) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"의 내용이야. ` +
    '이 문서의 주제·분위기에 어울리는 배경음악 스타일을 AI 음악 생성 모델(MusicGen)에 줄 영어 프롬프트로 ' +
    '한 문장에서 두 문장 이내로 묘사해줘. 악기 구성, 템포, 무드 위주로 구체적으로 써줘. ' +
    '다른 설명이나 따옴표 없이 그 영어 묘사문만 출력해.\n\n' +
    `--- 문서 내용 ---\n${context}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  return (data.response || '').trim().replace(/^["']|["']$/g, '');
}

async function generateYoutubeMeta(pageTitle, context) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"의 내용과, 여기 첨부된 PDF에서 뽑은 텍스트야. ` +
    '이 내용을 소개하는 유튜브 영상에 쓸 제목과 설명을 만들어줘. ' +
    '아래 형식 그대로, 다른 말 없이 정확히 두 줄로만 답해:\n' +
    '제목: (한 줄, 60자 이내, 흥미를 끌 만한 한국어 제목)\n' +
    '설명: (2~4문장, 영상 내용을 요약하는 한국어 설명)\n\n' +
    `--- 문서 내용 ---\n${context}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();

  const titleMatch = text.match(/제목\s*[:：]\s*(.+)/);
  const descMatch = text.match(/설명\s*[:：]\s*([\s\S]+)/);
  return {
    title: titleMatch ? titleMatch[1].trim() : pageTitle,
    description: descMatch ? descMatch[1].trim() : text,
  };
}

// Picks exactly `count` essential functions for implementing whatever
// algorithm/concept the page describes, each one fully working (not a
// skeleton), and returns { code, explanation } for each - `explanation` is a
// one-line description meant to sit right under that function's code block.
async function generateCoreFunctions(pageTitle, pageBody, count = 3) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"의 내용이야. ` +
    '이 문서가 설명하는 알고리즘이나 개념을 실제로 동작하는 코드로 완전히 구현하려고 해. ' +
    `이 구현을 정확히 ${count}개의 함수로 나눠서 각각 파이썬으로 작성해줘 (내용이 단순해 보여도 반드시 ${count}개로 나눠라 - 예를 들어 핵심 계산 함수, 그 계산을 반복/적용하는 함수, 전체를 실행하는 함수처럼 역할을 나누면 돼). ` +
    '조건: ' +
    '1) 문서에 설명된 로직을 뼈대만 만들지 말고, 설명된 내용을 실제로 전부 동작하도록 구현해 (pass, TODO, "...생략..." 같은 자리표시자 금지). ' +
    `2) 함수는 정확히 ${count}개여야 하고, 서로 실제로 호출하며 이어지는 하나의 구현이 되게 해 (의미 없이 쪼개지 말고, 각자 뚜렷한 역할이 있어야 해). ` +
    '3) 꼭 필요한 경우에만 import를 써. ' +
    `4) 함수마다 아래 형식을 정확히 지켜서, 다른 설명 문장 없이 이 형식만 ${count}번 반복해서 답해:\n` +
    '```python\n(코드)\n```\n' +
    '설명: (그 함수가 하는 일을 한 줄로, 마크다운 기호 없이 평문으로)\n\n' +
    `--- 문서 내용 ---\n${pageBody}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();

  const pairs = [...text.matchAll(/```(?:python)?\s*\n([\s\S]*?)```\s*설명\s*[:：]\s*(.+)/gi)]
    .map((m) => ({ code: m[1].trim(), explanation: m[2].trim() }))
    .filter((f) => f.code);

  let functions = pairs.slice(0, count);
  if (!functions.length) {
    // Model didn't follow the code+설명 pairing - fall back to code-only blocks.
    functions = [...text.matchAll(/```(?:python)?\s*\n([\s\S]*?)```/gi)]
      .map((m) => ({ code: m[1].trim(), explanation: '' }))
      .filter((f) => f.code)
      .slice(0, count);
  }
  if (!functions.length) throw new Error('핵심 함수 코드를 생성하지 못했습니다.');
  return functions;
}

// Draws a Mermaid flowchart of the overall algorithm's execution order, with
// the given function names placed at the step(s) where they're actually
// called, so the reader can see where each core function fits in the whole.
// The nodes for those steps are then deterministically highlighted (not left
// to the model to style correctly).
async function generateFlowDiagram(pageTitle, pageBody, funcNames) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"의 내용이고, 이 알고리즘을 구현하기 위해 고른 핵심 함수들이야: ${funcNames.join(', ')}. ` +
    '이 알고리즘이 처음부터 끝까지 실행되는 전체 순서를 Mermaid 플로우차트(flowchart TD)로 그려줘. ' +
    '조건: ' +
    `1) 위 함수들이 실제로 호출되는 단계는 반드시 노드로 넣고, 그 노드의 ID를 함수 이름과 정확히 똑같은 글자로 써라 (예를 들어 ${funcNames[0]} 함수가 호출되는 단계면 노드를 ${funcNames[0]}[${funcNames[0]} 설명] 처럼 적어라 - 괄호 앞 식별자가 함수 이름과 한 글자도 달라선 안 돼). ` +
    '2) 함수 호출과 무관한 단계(데이터 준비, 반복 조건 판단, 종료 등)의 노드는 함수 이름과 겹치지 않는 다른 ID를 써라. ' +
    '3) 다른 설명 문장 없이 mermaid 코드블록만 답해 (```mermaid ... ```).\n\n' +
    `--- 문서 내용 ---\n${pageBody}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();

  const fenced = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/i);
  let diagram = (fenced ? fenced[1] : text).trim();
  if (!diagram) throw new Error('흐름도를 생성하지 못했습니다.');

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const present = funcNames.filter((n) => new RegExp(`(^|\\s)${escapeRe(n)}[[({]`).test(diagram));
  if (present.length) {
    diagram +=
      '\n\n    classDef corefunc fill:#ffd43b,stroke:#e8590c,stroke-width:3px,color:#000;\n' +
      `    class ${present.join(',')} corefunc;`;
  }

  return diagram;
}

// Translates a short piece of text (the video title or description pulled
// out of a page) into English, steering clear of this wiki's own tag
// characters (*, !) so the result can't accidentally turn into a bogus link
// or emphasis run once it's appended back into the page.
async function translateToEnglish(pageTitle, text) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"에 첨부된 동영상의 제목 또는 설명 텍스트야. 이 텍스트를 자연스러운 영어로 번역해줘. ` +
    '조건: ' +
    '1) 별표(*)나 느낌표(!)로 단어를 감싸지 마라 (이 위키에서 링크/강조 문법으로 해석된다). ' +
    '2) 다른 설명이나 인사말 없이, 번역된 문장만 답해.\n\n' +
    `--- 원문 ---\n${text}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const translated = (data.response || '').trim();
  if (!translated) throw new Error('번역 결과가 비어 있습니다.');
  return translated;
}

// Batch-translates a list of { title, snippet } items (RSS feed entries)
// into Korean in a single request, rather than one call per item. Each
// field is asked to stay on one line so the reply can be parsed line by
// line; a sparse array is returned (missing indices just mean the model
// dropped that item, and the caller should keep the original text for it).
async function translateFeedItemsToKorean(items) {
  const numbered = items
    .map((it, i) => `${i + 1}. 제목: ${it.title || ''}\n   요약: ${it.snippet || '(없음)'}`)
    .join('\n');
  const prompt =
    `다음은 RSS 피드에서 가져온 뉴스 항목 ${items.length}개야. 각 항목의 "제목"과 "요약"을 자연스러운 한국어로 번역해줘. ` +
    '조건: ' +
    '1) 이미 한국어인 항목도 자연스럽게 다듬어서 같이 답해라. ' +
    '2) 별표(*)나 느낌표(!)로 단어를 감싸지 마라 (이 위키에서 링크/강조 문법으로 해석된다). ' +
    '3) 제목과 요약은 각각 줄바꿈 없이 한 줄로 써라. ' +
    `4) 아래와 정확히 같은 형식으로, 번호를 원문과 동일하게 ${items.length}개 그대로 유지해서 답해 (다른 설명 없이):\n` +
    '1. 제목: (번역된 제목)\n   요약: (번역된 요약)\n2. 제목: (번역된 제목)\n   요약: (번역된 요약)\n\n' +
    `--- 원문 ---\n${numbered}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();

  const results = [];
  let currentIdx = null;
  for (const line of text.split('\n')) {
    const titleMatch = line.match(/^\s*(\d+)\.\s*제목\s*[:：]\s*(.+)$/);
    const snippetMatch = line.match(/^\s*요약\s*[:：]\s*(.+)$/);
    if (titleMatch) {
      currentIdx = Number(titleMatch[1]) - 1;
      results[currentIdx] = { title: titleMatch[2].trim(), snippet: '' };
    } else if (snippetMatch && currentIdx !== null && results[currentIdx]) {
      results[currentIdx].snippet = snippetMatch[1].trim();
    }
  }
  if (!results.some(Boolean)) throw new Error('번역 결과를 해석하지 못했습니다.');
  return results;
}

// Summarizes an attached paper's extracted PDF text into three fixed
// Korean sections (핵심 기여/방법론/실험 결과) rather than a free-form
// summary, so the result is consistently structured no matter what shape
// the source paper takes.
async function summarizePaper(pageTitle, pdfText) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"에 첨부된 논문 PDF에서 추출한 텍스트야. 이 논문을 한국어로 구조화해서 요약해줘. ` +
    '조건: ' +
    '1) 반드시 "핵심 기여", "방법론", "실험 결과" 이 세 항목으로만 나눠서 답해라. ' +
    '2) 각 항목은 2~4문장의 자연스러운 한국어 평문으로, 줄바꿈 없이 한 줄로 써라. ' +
    '3) 별표(*)나 느낌표(!)로 단어를 감싸지 마라 (이 위키에서 링크/강조 문법으로 해석된다). ' +
    '4) 다른 설명이나 인사말 없이, 아래 형식 그대로 정확히 답해:\n' +
    '핵심 기여: (내용)\n방법론: (내용)\n실험 결과: (내용)\n\n' +
    `--- 논문 텍스트 ---\n${pdfText}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();

  const contribution = text.match(/핵심\s*기여\s*[:：]\s*([\s\S]*?)(?=\n\s*방법론\s*[:：]|$)/);
  const methodology = text.match(/방법론\s*[:：]\s*([\s\S]*?)(?=\n\s*실험\s*결과\s*[:：]|$)/);
  const results = text.match(/실험\s*결과\s*[:：]\s*([\s\S]*)$/);
  const summary = {
    contribution: contribution ? contribution[1].trim() : '',
    methodology: methodology ? methodology[1].trim() : '',
    results: results ? results[1].trim() : '',
  };
  if (!summary.contribution && !summary.methodology && !summary.results) {
    throw new Error('논문 요약 결과를 해석하지 못했습니다.');
  }
  return summary;
}

// Rewrites an attached resume (extracted as markdown via pandoc, see
// lib/video.js's docxToMarkdown) to better match a job posting described in
// the page's own body text. Both inputs are real - the resume content and
// whatever the page actually says about the target role - the model only
// rewords/reorders/re-emphasizes, it doesn't invent new job history or
// credentials. Uses ###-delimited markers instead of the "label: value"
// style other functions here use, since the resume body itself is long,
// multi-line, and full of colons/headings that would break a regex parse.
async function optimizeResume(pageBody, resumeMarkdown) {
  const prompt =
    '다음은 위키 문서의 본문(지원하려는 회사/채용 공고 정보가 담겨 있음)과, 그 문서에 첨부된 이력서를 마크다운으로 추출한 내용이야. ' +
    '이 채용 공고에 맞춰 이력서 내용을 최적화해줘. ' +
    '조건: ' +
    '1) 이력서에 없는 경력, 학력, 자격을 새로 지어내지 마라 - 실제로 이력서에 있는 내용만 채용 공고에 맞게 표현을 다듬고, 관련 있는 항목은 강조하고, 무관한 세부사항은 줄여라. ' +
    '2) 이력서의 마크다운 구조(제목 #, 목록 - 등)는 그대로 유지하되 내용만 다듬어라. ' +
    '3) 다른 설명 없이 아래 형식 그대로 정확히 답해:\n' +
    '###RESUME_START###\n(최적화된 이력서 전체를 마크다운으로)\n###RESUME_END###\n' +
    '###CHANGES_START###\n(무엇을 왜 바꿨는지 2~4개의 "- "로 시작하는 한국어 목록. 별표(*)나 느낌표(!)로 단어를 감싸지 마라)\n###CHANGES_END###\n\n' +
    `--- 문서 본문(채용 공고 정보) ---\n${pageBody}\n\n` +
    `--- 원본 이력서(마크다운) ---\n${resumeMarkdown}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();

  const resumeMatch = text.match(/###RESUME_START###([\s\S]*?)###RESUME_END###/);
  const changesMatch = text.match(/###CHANGES_START###([\s\S]*?)###CHANGES_END###/);
  const optimizedMarkdown = resumeMatch ? resumeMatch[1].trim() : '';
  const changes = changesMatch ? changesMatch[1].trim() : '';
  if (!optimizedMarkdown) {
    throw new Error('이력서 최적화 결과를 해석하지 못했습니다.');
  }
  return { optimizedMarkdown, changes };
}

// One-line "why are these related" explanation for the related-pages
// recommendation feature. The candidate pages themselves come from the real
// link graph (lib/wiki.js's findRelatedPages), never from the model - this
// only asks Ollama to explain a connection that's already established,
// rather than to invent one.
async function explainRelation(currentTitle, currentExcerpt, relatedTitle, relatedExcerpt) {
  const prompt =
    `다음은 위키의 두 문서에서 뽑은 내용 일부야. 이 두 문서 "${currentTitle}"과 "${relatedTitle}"가 ` +
    '왜 서로 관련 있는지 한국어로 한 문장만 설명해줘. ' +
    '조건: ' +
    '1) 20~60자 정도의 한 문장으로, 마크다운이나 위키 기호(#, *, `, - 등) 없이 순수 텍스트로만 답해라. ' +
    '2) 다른 설명이나 인사말 없이 그 한 문장만 답해라.\n\n' +
    `--- 문서 A: "${currentTitle}" ---\n${currentExcerpt}\n\n--- 문서 B: "${relatedTitle}" ---\n${relatedExcerpt}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  return (data.response || '').trim().replace(/\s+/g, ' ');
}

// Summarizes an attached YouTube video from its caption/transcript text
// (the model can't watch the video itself - the transcript, fetched
// separately via lib/youtube.js, is the only actual video content it sees).
async function summarizeYoutubeVideo(pageTitle, videoTitle, transcript) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"에 첨부된 유튜브 영상 "${videoTitle}"의 자막(자동 생성 자막 포함) 텍스트야. ` +
    '이 영상 내용을 한국어로 요약해줘. ' +
    '조건: ' +
    '1) 먼저 "요약:" 뒤에 2~4문장의 자연스러운 한국어 평문 요약을 줄바꿈 없이 한 줄로 써라. ' +
    '2) 그다음 "핵심 포인트:" 를 쓰고, 그 아래 줄부터 이 영상의 핵심 내용을 3~5개의 "- " 로 시작하는 목록으로 써라 (각 항목은 한 줄, 20~50자 정도). ' +
    '3) 별표(*)나 느낌표(!)로 단어를 감싸지 마라 (이 위키에서 링크/강조 문법으로 해석된다). ' +
    '4) 다른 설명이나 인사말 없이, 위 형식 그대로만 답해.\n\n' +
    `--- 자막 텍스트 ---\n${transcript}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();

  const summaryMatch = text.match(/요약\s*[:：]\s*(.+)/);
  const pointsMatch = text.match(/핵심\s*포인트\s*[:：]\s*([\s\S]*)$/);
  const points = pointsMatch ? [...pointsMatch[1].matchAll(/^-\s*(.+)$/gm)].map((m) => m[1].trim()) : [];
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  if (!summary && !points.length) throw new Error('영상 요약 결과를 해석하지 못했습니다.');
  return { summary, points };
}

// Generates the ONE function this page's algorithm needs to actually run,
// for the "코드로 테스트하기" feature, plus a schema for any tunable
// parameters (thresholds, kernel sizes, filter modes, ...) so the page can
// expose them as live slider/dropdown controls. Deliberately asks for a
// single function with keyword parameters (not a whole script) so the
// caller (server.js) controls the entry point/CLI args itself - the model
// only ever supplies the algorithm body and what its own tunable inputs
// are, never how it's invoked.
//
// The page's own content decides the modality, not what happens to be
// attached: a document describing a spectrogram/phase/filtering algorithm
// gets process_audio(...) even if an image also happens to be on the page,
// and vice versa. server.js is responsible for then finding the matching
// attachment and erroring out if it isn't there.
async function generateImageProcessingCode(pageTitle, pageBody) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"의 내용이야. 이 문서가 설명하는 알고리즘을 실제로 동작하는 파이썬 코드로 구현하려고 해. ` +
    '조건: ' +
    '1) 먼저, 이 알고리즘이 근본적으로 다루는 데이터가 이미지인지, 오디오인지, 비디오인지, 그리고 그 결과를 보여주기에 가장 적절한 형태가 무엇인지 판단해서 아래 JSON으로 답해줘. ' +
    '(예: 스펙트로그램·위상·주파수 필터·노이즈 제거처럼 소리/신호를 다루면 input_type은 "audio". 사진·화소·윤곽선·색상처럼 정지 이미지 한 장을 다루면 "image". ' +
    '움직임·프레임 간 변화·시간에 따른 장면(샐리언시, 옵티컬 플로우, 배경 제거, 객체 추적 등)을 다루면 "video". ' +
    'output_type은 결과를 가장 잘 보여주는 형태를 골라줘 - 스펙트로그램/히트맵/그래프처럼 정지된 한 장으로 보여줄 수 있는 결과는 "image", 필터링된 소리 자체가 결과라면 "audio", 매 프레임마다 처리 결과를 시각화해서 보여줘야 하는 비디오 알고리즘이라면 "video".) ' +
    '조절할 만한 핵심 파라미터(임계값, 커널 크기, 반복 횟수, 필터 종류, 컷오프 주파수 등)가 있으면 함께 나열하고, 없으면 빈 배열로 답해:\n' +
    '```json\n' +
    '{\n' +
    '  "input_type": "image 또는 audio 또는 video",\n' +
    '  "output_type": "image 또는 audio 또는 video",\n' +
    '  "params": [\n' +
    '    { "name": "영문_파라미터명", "label": "한국어 설명", "type": "slider", "min": 최소값, "max": 최대값, "step": 증가폭, "default": 기본값 },\n' +
    '    { "name": "영문_파라미터명", "label": "한국어 설명", "type": "combobox", "options": ["값1", "값2"], "default": "기본값" }\n' +
    '  ]\n' +
    '}\n' +
    '```\n' +
    '2) input_type이 "image"면 정확히 이 형태의 함수 하나만 작성해: def process_image(input_path: str, output_path: str, 파라미터1=기본값1, ...) -> None: ' +
    '이 함수는 input_path의 이미지 파일을 PIL 또는 cv2로 열어서 처리하고, 결과 이미지를 output_path에 PNG로 저장해야 해. PIL(Pillow), numpy, cv2(OpenCV), scipy 라이브러리만 사용해. ' +
    '3) input_type이 "audio"면 정확히 이 형태의 함수 하나만 작성해: def process_audio(input_path: str, output_path: str, 파라미터1=기본값1, ...) -> None: ' +
    'input_path는 항상 16비트 PCM WAV 파일이야 - scipy.io.wavfile.read(input_path)로 (sample_rate, samples)를 얻어서 처리해 (samples는 모노면 1차원, 스테레오면 (N,2) 형태의 int16 배열). ' +
    'output_type이 "audio"면 결과를 scipy.io.wavfile.write(output_path, sample_rate, result)로 저장해(result는 int16 또는 float32 numpy 배열). ' +
    'output_type이 "image"면 matplotlib을 반드시 Agg 백엔드로 설정한 뒤(import matplotlib 바로 다음 줄에 matplotlib.use("Agg")) 스펙트로그램/그래프를 그려서 plt.savefig(output_path)로 저장해. numpy, scipy(scipy.io.wavfile, scipy.signal 등), matplotlib만 사용해. ' +
    '4) input_type이 "video"면 정확히 이 형태의 함수 하나만 작성해: def process_video(input_path: str, output_path: str, 파라미터1=기본값1, ...) -> None: ' +
    'input_path는 cv2.VideoCapture(input_path)로 프레임 단위로 읽어. ' +
    'output_type이 "video"면 cv2.VideoCapture에서 얻은 원본과 같은 fps/가로세로 크기로 cv2.VideoWriter(output_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))를 만들어 처리한 프레임을 순서대로 write()하고 끝나면 반드시 release()해 (실제 코덱 호환성은 서버가 나중에 다시 인코딩하므로 신경 쓰지 마). ' +
    'output_type이 "image"면 전체 영상을 훑어 만든 대표 결과(예: 평균 샐리언시 맵, 특정 프레임 히트맵 등) 하나를 matplotlib(Agg 백엔드) 또는 cv2.imwrite로 output_path에 저장해. numpy, cv2(OpenCV), scipy, matplotlib만 사용해. ' +
    '5) 함수의 키워드 인자 이름은 JSON의 "params" 각 항목 "name" 값과 정확히 똑같아야 해 (파라미터가 없으면 input_path, output_path만 받는 함수를 작성해). ' +
    '6) 화면에 띄우거나 재생하는 동작(cv2.imshow, plt.show, Image.show, sounddevice 재생 등)은 절대 쓰지 마 - 반드시 output_path에 파일로 저장만 해. ' +
    '7) pip install, 네트워크 요청, 다른 파일 시스템 접근은 절대 쓰지 마. ' +
    '8) 뼈대나 pass, "...생략..." 없이 설명된 내용을 실제로 전부 동작하도록 구현해. ' +
    '9) 함수 정의 위에 필요한 import문을 전부 포함시켜. ' +
    '10) 다른 설명 문장 없이, 먼저 위 JSON 코드블록(```json ... ```) 하나, 그다음 파이썬 코드블록(```python ... ```) 하나, 이렇게 정확히 두 개만 답해.\n\n' +
    `--- 문서 내용 ---\n${pageBody}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();

  const pythonFenced = text.match(/```python\s*\n([\s\S]*?)```/i);
  const code = (pythonFenced ? pythonFenced[1] : '').trim();

  // Trust whichever function name the code actually defines over the JSON's
  // own input_type claim - that's what's really going to run, and the two
  // could in principle disagree if the model was inconsistent.
  const hasProcessImage = /def\s+process_image\s*\(/.test(code);
  const hasProcessAudio = /def\s+process_audio\s*\(/.test(code);
  const hasProcessVideo = /def\s+process_video\s*\(/.test(code);
  if (!code || (!hasProcessImage && !hasProcessAudio && !hasProcessVideo)) {
    throw new Error('process_image, process_audio, process_video 중 어떤 함수도 생성하지 못했습니다.');
  }
  const inputType = hasProcessVideo ? 'video' : hasProcessAudio ? 'audio' : 'image';
  const funcName = hasProcessVideo ? 'process_video' : hasProcessAudio ? 'process_audio' : 'process_image';

  // The JSON metadata (output type + tunable params) is a nice-to-have, not
  // a hard requirement - if it doesn't parse, fall back to sensible
  // defaults rather than failing the whole feature, since the function
  // itself still works fine on its own built-in defaults either way.
  let outputType = 'image';
  let params = [];
  const jsonFenced = text.match(/```json\s*\n([\s\S]*?)```/i);
  if (jsonFenced) {
    try {
      const parsed = JSON.parse(jsonFenced[1]);
      if (parsed && typeof parsed === 'object') {
        if (parsed.output_type === 'audio' || parsed.output_type === 'video') outputType = parsed.output_type;
        if (Array.isArray(parsed.params)) {
          // Only keep entries whose "name" genuinely appears as a keyword
          // parameter in the generated function signature - a schema entry
          // for a parameter the function doesn't actually accept would just
          // cause a TypeError when the live-preview control tries to use it.
          const sigMatch = code.match(new RegExp(`def\\s+${funcName}\\s*\\(([^)]*)\\)`));
          const sigNames = new Set(
            sigMatch
              ? sigMatch[1]
                  .split(',')
                  .map((p) => p.split('=')[0].split(':')[0].trim())
                  .filter(Boolean)
              : []
          );
          params = parsed.params.filter((p) => p && typeof p.name === 'string' && sigNames.has(p.name));
        }
      }
    } catch {
      params = [];
    }
  }

  return { code, inputType, outputType, params };
}

// Writes a complete, runnable openFrameworks (C++) project for the app the
// wiki page describes - exactly three files: src/main.cpp (ofSetupOpenGL +
// ofRunApp), src/ofApp.h (class declaration), src/ofApp.cpp (setup/update/
// draw fully implemented). Only openFrameworks' core API is allowed so the
// result compiles with the project generator's default empty template, no
// addons needed. Files come back marked with "###FILE: <path>" lines, which
// the caller parses to rebuild the src/ tree and zip.
async function generateOpenFrameworksCode(pageTitle, pageBody) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"의 내용이야. 이 문서가 설명하는 앱을 openFrameworks(C++ 프레임워크)로 만드는 완전히 동작하는 코드를 작성하려고 해. ` +
    '정확히 다음 세 파일을 작성해줘:\n' +
    '1) src/main.cpp - ofSetupOpenGL(...)과 ofRunApp(new ofApp())을 호출하는 main() 함수 (창 크기는 앱에 맞게 정하고, 아무 인자도 받지 않는 main()으로)\n' +
    '2) src/ofApp.h - #pragma once, ofMain.h include, class ofApp : public ofBaseApp 선언 (setup/update/draw 외에 앱에 필요한 이벤트 메서드 포함)\n' +
    '3) src/ofApp.cpp - setup()/update()/draw()를 포함해 문서가 설명하는 앱 동작을 전부 실제로 구현\n' +
    '조건: ' +
    '1) 뼈대나 "..." 또는 TODO 주석 없이, 문서가 설명하는 동작을 실제로 전부 동작하도록 구현해. ' +
    '2) 외부 애드온 없이 openFrameworks 핵심 API(ofMain.h로 사용 가능한 ofImage, ofSoundPlayer, ofFbo, ofTrueTypeFont 등)만 써서 컴파일되게 해. ' +
    '3) ofApp.cpp 안에 필요한 모든 include(ofMain.h 포함)를 직접 넣어서, 프로젝트 생성기에서 이 src/를 그대로 넣으면 컴파일되게 해. ' +
    '4) 코드 안에 \`\`\` 또는 ###FILE: 같은 마크다운 코드블록 표시를 절대 넣지 마. ' +
    '5) 각 파일은 아래 형식 그대로, 다른 설명 문장 없이 세 파일만 정확히 답해:\n' +
    '###FILE: src/main.cpp\n(코드)\n###FILE: src/ofApp.h\n(코드)\n###FILE: src/ofApp.cpp\n(코드)\n\n' +
    `--- 문서 내용 ---\n${pageBody}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();
  if (!text) throw new Error('openFrameworks 코드를 생성하지 못했습니다.');

  const files = [];
  // Parse "###FILE: <path>" markers line by line - C++ preprocessor lines
  // are a single '#', so the triple-hash marker can't collide with real
  // code, and the line-by-line approach survives the model starting with a
  // marker on the very first line (a bare .split() on /\n###FILE:/ would
  // swallow that first file into the pre-marker preamble).
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^###FILE:\s*(\S.*)$/);
    if (m) {
      current = { filename: m[1].trim(), codeLines: [] };
      files.push(current);
    } else if (current) {
      current.codeLines.push(line);
    }
  }
  const result = files
    .filter((f) => f.filename && f.codeLines.join('\n').trim())
    .map((f) => {
      // The model occasionally wraps the file in a fenced block anyway - peel
      // any ``` / ```cpp fences off the code before keeping it.
      const code = f.codeLines
        .join('\n')
        .trim()
        .replace(/^```(?:cpp|c\+\+|c)?\s*\n?/, '')
        .replace(/\n?```\s*$/, '');
      return { filename: f.filename.replace(/^\.?\//, ''), code };
    })
    .filter((f) => f.code);

  const names = result.map((f) => f.filename);
  for (const required of ['src/main.cpp', 'src/ofApp.h', 'src/ofApp.cpp']) {
    if (!names.includes(required)) {
      throw new Error(`openFrameworks 프로젝트를 완성하지 못했습니다 (${required} 누락).`);
    }
  }
  return result;
}

// Writes a complete, runnable SwiftUI iOS app for the app the wiki page
// describes - exactly two files: App.swift (the @main App struct) and
// ContentView.swift (the main view fully implementing the described
// behavior). Only Apple's system frameworks (SwiftUI, AVFoundation, CoreML,
// ...) are allowed, so the files drop straight into a fresh Xcode "iOS App"
// project with no extra packages or app entry fiddling. Files come back
// marked with "###FILE: <path>" lines, parsed exactly like the
// openFrameworks feature above.
async function generateSwiftCode(pageTitle, pageBody) {
  const prompt =
    `다음은 위키 문서 "${pageTitle}"의 내용이야. 이 문서가 설명하는 앱을 SwiftUI(iOS)로 만드는 완전히 동작하는 코드를 작성하려고 해. ` +
    '정확히 다음 두 파일을 작성해줘:\n' +
    '1) App.swift - @main struct가 있는 SwiftUI App 진입점 (WindowGroup 안에 ContentView()를 넣고, app이름은 문서 내용에 맞게)\n' +
    '2) ContentView.swift - 앱의 메인 화면(뷰) 전체 구현. 문서가 설명하는 동작을 state/속성/상호작용으로 전부 실제로 구현\n' +
    '조건: ' +
    '1) 뼈대나 "..." 또는 TODO 주석 없이, 문서가 설명하는 동작을 실제로 전부 동작하도록 구현해. ' +
    '2) Apple 시스템 프레임워크(SwiftUI, UIKit, AVFoundation, CoreImage, CoreML, Vision, Combine, Foundation 등)만 쓰고, 외부 패키지(Swift Package) 의존성은 절대 쓰지 마. ' +
    '3) 두 파일 모두 필요한 import 문을 파일 맨 위에 직접 넣어서, Xcode의 "iOS App" 새 프로젝트 템플릿에 이 두 파일을 그대로 넣으면 컴파일되게 해. ' +
    '4) 한 뷰 파일 안에서 앱이 끝나게 하지 말고, 화면 구조는 SwiftUI View와 필요한 subview/구조체로 나눠서 정리해. ' +
    '5) 코드 안에 \`\`\` 또는 ###FILE: 같은 마크다운 코드블록 표시를 절대 넣지 마. ' +
    '6) 각 파일은 아래 형식 그대로, 다른 설명 문장 없이 두 파일만 정확히 답해:\n' +
    '###FILE: App.swift\n(코드)\n###FILE: ContentView.swift\n(코드)\n\n' +
    `--- 문서 내용 ---\n${pageBody}`;

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
  const data = await res.json();
  const text = (data.response || '').trim();
  if (!text) throw new Error('Swift 코드를 생성하지 못했습니다.');

  // Same "###FILE:" line-by-line parse as generateOpenFrameworksCode.
  const files = [];
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^###FILE:\s*(\S.*)$/);
    if (m) {
      current = { filename: m[1].trim(), codeLines: [] };
      files.push(current);
    } else if (current) {
      current.codeLines.push(line);
    }
  }
  const result = files
    .filter((f) => f.filename && f.codeLines.join('\n').trim())
    .map((f) => {
      const code = f.codeLines
        .join('\n')
        .trim()
        .replace(/^```(?:swift)?\s*\n?/, '')
        .replace(/\n?```\s*$/, '');
      return { filename: f.filename.replace(/^\.?\//, ''), code };
    })
    .filter((f) => f.code);

  const names = result.map((f) => f.filename);
  for (const required of ['App.swift', 'ContentView.swift']) {
    if (!names.includes(required)) {
      throw new Error(`iOS 앱 프로젝트를 완성하지 못했습니다 (${required} 누락).`);
    }
  }
  return result;
}

module.exports = {
  OLLAMA_MODEL,
  defineTerm,
  generateMusicStylePrompt,
  generateYoutubeMeta,
  generateCoreFunctions,
  generateFlowDiagram,
  translateToEnglish,
  translateFeedItemsToKorean,
  summarizePaper,
  optimizeResume,
  explainRelation,
  summarizeYoutubeVideo,
  generateImageProcessingCode,
  generateOpenFrameworksCode,
  generateSwiftCode,
};
