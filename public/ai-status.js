// Sidebar "AI 엔진" indicator: shows which Ollama model answers this wiki's
// AI buttons (glossary, core-function, translate, summaries, code
// generation, etc.), and lights up while any of those requests are
// in-flight, by wrapping window.fetch and matching known AI endpoint paths.
(function () {
  var dot = document.getElementById('ai-status-dot');
  var modelLabel = document.getElementById('ai-status-model');
  if (!dot || !modelLabel) return;

  var modelSelect = document.getElementById('ai-model-select');
  var modelStatus = document.getElementById('ai-model-status');

  var modelName = '';
  var inFlight = 0;

  var AI_PATH_SUFFIXES = [
    '/glossarize',
    '/core-function',
    '/translate',
    '/pdf-summary',
    '/resume-optimize',
    '/related-pages',
    '/youtube-summary',
    '/code-test',
    '/openframeworks-code',
    '/swift-code',
    '/make-video',
    '/rss-translate',
    '/ai-edit',
  ];

  function isAiRequest(url, method) {
    if ((method || 'GET').toUpperCase() !== 'POST') return false;
    var path;
    try {
      path = new URL(url, window.location.origin).pathname;
    } catch (e) {
      path = String(url);
    }
    return AI_PATH_SUFFIXES.some(function (suffix) {
      return path.indexOf(suffix) === path.length - suffix.length;
    });
  }

  function render() {
    if (inFlight > 0) {
      dot.classList.add('active');
      modelLabel.textContent = '작동 중 · ' + modelName;
    } else {
      dot.classList.remove('active');
      modelLabel.textContent = '대기 중 · ' + modelName;
    }
  }

  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
    var tracked = isAiRequest(url, method);

    if (tracked) {
      inFlight += 1;
      render();
    }

    var result = originalFetch.apply(this, arguments);
    if (tracked) {
      result.finally(function () {
        inFlight = Math.max(0, inFlight - 1);
        render();
      });
    }
    return result;
  };

  function populateSelect(models, selected) {
    if (!modelSelect) return;
    modelSelect.innerHTML = '';
    // The currently active model might not be in Ollama's own list yet (a
    // ":cloud" model only shows up there after it's actually been used
    // once) - keep it selectable regardless, so the combo box never shows
    // the wrong thing selected.
    var names = models.slice();
    if (selected && names.indexOf(selected) === -1) names.unshift(selected);
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    });
    if (selected) modelSelect.value = selected;
  }

  Promise.all([
    fetch('/api/ai-model').then(function (res) { return res.json(); }),
    fetch('/api/ai-models').then(function (res) { return res.json(); }).catch(function () { return { models: [] }; }),
  ])
    .then(function (results) {
      var current = results[0].model || '';
      var available = results[1].models || [];
      modelName = current || '알 수 없음';
      populateSelect(available, current);
      render();
    })
    .catch(function () {
      modelName = '알 수 없음';
      render();
    });

  if (modelSelect) {
    modelSelect.addEventListener('change', function () {
      var name = modelSelect.value;
      if (!name) return;
      modelSelect.disabled = true;
      if (modelStatus) modelStatus.textContent = '모델을 변경하는 중...';

      fetch('/api/ai-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) throw new Error(data.error || '모델 변경 실패');
            return data;
          });
        })
        .then(function (data) {
          modelName = data.model;
          if (modelStatus) modelStatus.textContent = '적용됨: ' + modelName;
          render();
        })
        .catch(function (err) {
          if (modelStatus) modelStatus.textContent = err.message || '모델 변경에 실패했습니다.';
        })
        .finally(function () {
          modelSelect.disabled = false;
        });
    });
  }
})();
