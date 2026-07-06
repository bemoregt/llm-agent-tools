# Octave 코드 예제 모음

이 세션에서 실행한 Octave 코드를 순서대로 정리한 문서입니다.

---

## 1. 1부터 10까지 합산

```octave
result = sum(1:10);
printf('1부터 10까지의 합: %d\n', result);
```

**출력**
```
1부터 10까지의 합: 55
```

---

## 2. sin 그래프

```octave
x = linspace(0, 2*pi, 100);
y = sin(x);
plot(x, y);
xlabel('x');
ylabel('sin(x)');
title('sin 그래프');
grid on;
```

---

## 3. 이미지 생성 + 2D 푸리에 변환 + 스펙트럼 표시

`peaks()` 함수로 256×256 테스트 이미지를 생성하고, 2D FFT 후 원본과 스펙트럼을 나란히 표시합니다.

```octave
t_total_start = tic;

% 이미지 생성
t1 = tic;
img = peaks(256);
img = (img - min(img(:))) / (max(img(:)) - min(img(:))) * 255;
t1_elapsed = toc(t1);
printf('[시간] 이미지 생성: %.4f초\n', t1_elapsed);

% 2D 푸리에 변환
t2 = tic;
F = fft2(img);
F_shifted = fftshift(F);
magnitude_spectrum = log(1 + abs(F_shifted));
t2_elapsed = toc(t2);
printf('[시간] 2D 푸리에 변환: %.4f초\n', t2_elapsed);

% 시각화 (원본 | 스펙트럼)
t3 = tic;
figure(1);
set(gcf, 'Position', [100 100 1100 480]);

subplot(1, 2, 1);
imagesc(img);
colormap(gray);
colorbar;
title('원본 이미지 (peaks 함수, 256x256)');
xlabel('x'); ylabel('y');
axis equal tight;

subplot(1, 2, 2);
imagesc(magnitude_spectrum);
colormap(jet);
colorbar;
title('2D FFT 스펙트럼 (log 스케일, fftshift 적용)');
xlabel('주파수 u'); ylabel('주파수 v');
axis equal tight;

t3_elapsed = toc(t3);
printf('[시간] 이미지 표시: %.4f초\n', t3_elapsed);

t_total_elapsed = toc(t_total_start);
printf('========================================\n');
printf('[시간] 이미지 생성:   %.4f초\n', t1_elapsed);
printf('[시간] 2D FFT 변환:   %.4f초\n', t2_elapsed);
printf('[시간] 이미지 표시:   %.4f초\n', t3_elapsed);
printf('[시간] 전체 소요:     %.4f초\n', t_total_elapsed);
printf('========================================\n');
```

**결과 로그**
```
[시간] 이미지 생성:   0.0054초
[시간] 2D FFT 변환:   0.0026초
[시간] 이미지 표시:   0.3549초
[시간] 전체 소요:     0.3630초
```

---

## 4. 역푸리에 변환으로 이미지 복원 + 편차 히트맵

FFT → IFFT 복원 후 원본과의 픽셀 편차를 `hot` 컬러맵 히트맵으로 표시합니다.

```octave
t_total_start = tic;

% 원본 이미지 생성
t1 = tic;
img = peaks(256);
img = (img - min(img(:))) / (max(img(:)) - min(img(:))) * 255;
t1_elapsed = toc(t1);
printf('[시간] 원본 이미지 생성:       %.6f초\n', t1_elapsed);

% 2D 푸리에 변환
t2 = tic;
F = fft2(img);
F_shifted = fftshift(F);
magnitude_spectrum = log(1 + abs(F_shifted));
t2_elapsed = toc(t2);
printf('[시간] 2D 푸리에 변환:         %.6f초\n', t2_elapsed);

% 역푸리에 변환으로 이미지 복원
t3 = tic;
F_ishifted = ifftshift(F_shifted);        % fftshift 역순 복원
img_reconstructed = real(ifft2(F_ishifted));
t3_elapsed = toc(t3);
printf('[시간] 역푸리에 변환 (복원):   %.6f초\n', t3_elapsed);

% 편차 계산
t4 = tic;
diff_map = abs(img - img_reconstructed);
max_err  = max(diff_map(:));
mean_err = mean(diff_map(:));
t4_elapsed = toc(t4);
printf('[시간] 편차 계산:              %.6f초\n', t4_elapsed);
printf('       최대 오차: %.2e  /  평균 오차: %.2e\n', max_err, mean_err);

% 시각화: 원본 | 복원 | 편차 히트맵
t5 = tic;
figure(1);
set(gcf, 'Position', [50 100 1500 460]);

subplot(1, 3, 1);
imagesc(img);
colormap(gca, gray);
colorbar;
title('원본 이미지');
xlabel('x'); ylabel('y');
axis equal tight;

subplot(1, 3, 2);
imagesc(img_reconstructed);
colormap(gca, gray);
colorbar;
title('역FFT 복원 이미지');
xlabel('x'); ylabel('y');
axis equal tight;

subplot(1, 3, 3);
imagesc(diff_map);
colormap(gca, hot);
colorbar;
title(sprintf('편차 히트맵  (max=%.2e, mean=%.2e)', max_err, mean_err));
xlabel('x'); ylabel('y');
axis equal tight;

t5_elapsed = toc(t5);
printf('[시간] 시각화 렌더링:          %.6f초\n', t5_elapsed);

t_total_elapsed = toc(t_total_start);
printf('========================================\n');
printf('[시간] 전체 소요 시간:         %.6f초\n', t_total_elapsed);
printf('========================================\n');
```

**결과 로그**
```
[시간] 원본 이미지 생성:       0.005432초
[시간] 2D 푸리에 변환:         0.002436초
[시간] 역푸리에 변환 (복원):   0.001445초
[시간] 편차 계산:              0.002047초
       최대 오차: 1.42e-13  /  평균 오차: 2.44e-14
[시간] 시각화 렌더링:          0.423796초
[시간] 전체 소요 시간:         0.435254초
```

> 복원 오차가 머신 엡실론(~2.2e-16) 수준으로, FFT→IFFT는 수치적으로 완벽하게 역변환됩니다.

---

## 5. ResNet18 이미지 분류 추론 (Python 연동)

Octave에서 Python 스크립트를 호출하여 ResNet18(ImageNet) 모델로 너구리 이미지를 추론하고,  
결과를 오버레이한 이미지를 로드해 표시합니다.

### Octave 호출부

```octave
printf('ResNet18 추론 시작...\n');
t_start = tic;
[status, output] = system('python3 /tmp/resnet_infer.py 2>&1');
t_elapsed = toc(t_start);
printf('%s\n', output);
printf('[Octave] Python 실행 총 시간: %.3f초  (status=%d)\n', t_elapsed, status);

if status == 0
  out_path = '/Users/sgi/octave-mcp/outputs/resnet18_raccoon_result.png';
  result_img = imread(out_path);
  figure(1);
  set(gcf, 'Position', [50 50 1100 850]);
  imshow(result_img);
  title('ResNet18 Inference on Raccoon (scipy.datasets.face)');
  axis off;
end
```

### Python 스크립트 (`/tmp/resnet_infer.py`)

```python
# -*- coding: utf-8 -*-
import torch, torchvision, time, os
import numpy as np
from torchvision import models, transforms
from torchvision.models import ResNet18_Weights
import scipy.datasets
from PIL import Image, ImageDraw

t0 = time.time()

# 1. ResNet18 로드
weights = ResNet18_Weights.IMAGENET1K_V1
model = models.resnet18(weights=weights)
model.eval()
n_params = sum(p.numel() for p in model.parameters())

# 2. 너구리 이미지 로드 (scipy 내장)
#    주의: skimage.data.raccoon()은 v0.20에서 제거됨
#          pooch 설치 필요: pip install pooch
raccoon_np = scipy.datasets.face()   # (768, 1024, 3) uint8 RGB
img_pil = Image.fromarray(raccoon_np)

# 3. 전처리
preprocess = transforms.Compose([
    transforms.Resize(256),
    transforms.CenterCrop(224),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406],
                         std =[0.229, 0.224, 0.225]),
])
input_tensor = preprocess(img_pil).unsqueeze(0)

# 4. 추론
t_infer = time.time()
with torch.no_grad():
    output = model(input_tensor)
infer_ms = (time.time() - t_infer) * 1000

# 5. Top-5 결과
categories = weights.meta["categories"]
probs = torch.nn.functional.softmax(output[0], dim=0)
top5  = torch.topk(probs, 5)
results = []
for i, (prob, idx) in enumerate(zip(top5.values, top5.indices)):
    p = float(prob) * 100
    results.append((i+1, categories[idx], p))
    print(f"  Top{i+1}: {categories[idx]:<35s} {p:.2f}%")

# 6. 결과 이미지 오버레이 및 저장
# ... (이미지 어노테이션 코드 생략 - 전체 코드는 /tmp/resnet_infer.py 참조)
out_path = "/Users/sgi/octave-mcp/outputs/resnet18_raccoon_result.png"
```

**추론 결과 로그**
```
[0.116s] ResNet18 load OK  params=11,689,512
[0.116s] ImageNet classes: 1000
[0.188s] Raccoon image loaded: (768, 1024, 3)  (scipy.datasets.face)
[0.194s] Preprocess done: [1, 3, 224, 224]
[0.211s] Inference done: 17.1ms
  Top1: badger                              35.59%
  Top2: grey fox                            17.83%
  Top3: lesser panda                        8.63%
  Top4: three-toed sloth                    7.69%
  Top5: Madagascar cat                       2.45%
[0.212s] Total time: 212.3ms
```

> ImageNet-1K에 raccoon 클래스가 없어 유사 동물인 **badger(오소리)**로 분류됩니다.

---

## 환경 정보

| 항목 | 버전 |
|------|------|
| Python | 3.9.6 |
| torch | 2.8.0 |
| torchvision | 0.23.0 |
| scikit-image | 0.24.0 |
| Pillow | (최신) |
| OpenCV | 4.13.0 |
