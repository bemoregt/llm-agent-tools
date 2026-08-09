(function () {
  var status = document.getElementById('bgm-status');
  var btn = document.getElementById('bgm-btn');
  if (!btn) return;

  var currentMatch = location.pathname.match(/^\/page\/([^/]+)$/);
  var currentName = currentMatch ? decodeURIComponent(currentMatch[1]) : null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  btn.addEventListener('click', function () {
    if (!currentName) return;
    btn.disabled = true;
    setStatus('배경음악을 만드는 중입니다... (AI가 문서 분위기에 맞는 음악 스타일을 정하고, 로컬에서 음악을 생성해 동영상과 합칩니다. 몇 분 걸릴 수 있어요)');

    fetch('/page/' + encodeURIComponent(currentName) + '/add-bgm', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || '배경음악 생성 실패');
          return data;
        });
      })
      .then(function () {
        location.reload();
      })
      .catch(function (err) {
        setStatus(err.message || '배경음악 생성에 실패했습니다.');
        btn.disabled = false;
      });
  });
})();
