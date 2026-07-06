# octave-mcp

GNU Octave를 Claude AI와 연결하는 MCP(Model Context Protocol) 서버입니다.  
Claude Code에서 자연어로 Octave 코드를 실행하고, 수치 계산·그래프·이미지 처리·딥러닝 추론까지 바로 수행할 수 있습니다.

---

## 기능

- Octave 코드를 MCP 도구(`run_octave`)로 실행
- 텍스트 결과(stdout/stderr)를 Claude에게 반환
- `plot`, `imagesc`, `surf` 등 그래프 명령이 포함된 경우 PNG 파일로 자동 저장 후 이미지로 반환
- Python(`system()` 호출)을 통해 PyTorch/torchvision 등 외부 라이브러리 연동 가능

---

## 요구 사항

| 항목 | 버전 |
|------|------|
| Node.js | 18 이상 |
| GNU Octave | 6.0 이상 |
| Python | 3.9 이상 (딥러닝 기능 사용 시) |

### Python 선택적 의존성 (딥러닝 기능)

```
torch >= 2.0
torchvision >= 0.15
scikit-image >= 0.20
scipy >= 1.10
pooch          # scipy.datasets 이미지 로드에 필요
Pillow
```

---

## 설치

```bash
git clone <repo-url>
cd octave-mcp
npm install
```

---

## Claude Code MCP 등록

`~/.claude/claude_desktop_config.json` (또는 MCP 설정 파일)에 아래 내용을 추가합니다.

```json
{
  "mcpServers": {
    "octave": {
      "command": "node",
      "args": ["/Users/<yourname>/octave-mcp/index.js"]
    }
  }
}
```

---

## 사용 방법

Claude Code 대화창에서 자연어로 요청하면 됩니다.

```
Octave로 1부터 10까지 더한 값을 계산해줘
Octave로 sin 그래프를 그려줘
2D 푸리에 변환을 하고 스펙트럼을 표시해줘
ResNet18로 너구리 이미지 추론해줘
```

---

## 서버 구조

```
octave-mcp/
├── index.js          # MCP 서버 진입점
├── package.json
├── outputs/          # 생성된 그래프·이미지 저장 디렉토리
│   ├── plot_<uuid>.png
│   └── resnet18_raccoon_result.png
└── README.md
```

### 동작 흐름

1. Claude → MCP `run_octave` 도구 호출 (Octave 코드 전달)
2. `index.js`가 `octave --no-gui --eval <code>` 프로세스를 생성
3. 그래프 명령 감지 시 `print(gcf, '<path>', '-dpng', '-r150')`를 자동 삽입
4. stdout / 생성된 PNG를 Claude에게 반환

---

## 주요 사용 예시

### 수치 계산
```octave
result = sum(1:10);
printf('합계: %d\n', result);
% -> 55
```

### 2D 푸리에 변환 & 역변환
```octave
img = peaks(256);
F = fft2(img);
F_shifted = fftshift(F);
img_rec = real(ifft2(ifftshift(F_shifted)));
% 복원 오차: ~1e-13 (부동소수점 수준)
```

### ResNet18 이미지 분류 (Python 연동)
```octave
[status, out] = system('python3 /tmp/resnet_infer.py 2>&1');
% Top1: badger 35.59% / Top2: grey fox 17.83% ...
```

---

## 출력 파일

그래프 및 추론 결과 이미지는 `~/octave-mcp/outputs/` 에 저장됩니다.

| 파일 | 내용 |
|------|------|
| `plot_<uuid>.png` | Octave 그래프 출력 |
| `resnet18_raccoon_result.png` | ResNet18 추론 결과 오버레이 이미지 |

---

## 알려진 제한 사항

- `imshow` 등 일부 명령은 플롯 감지 패턴에 포함되지 않아 `imread`로 별도 로드 필요
- Octave 실행 타임아웃 기본값: **30초**
- `skimage.data.raccoon()`은 scikit-image v0.20에서 제거됨 → `scipy.datasets.face()` 사용
- ImageNet-1K에 raccoon 클래스 없음 → ResNet18은 유사 동물(badger 등)로 분류

---

## 라이선스

ISC
