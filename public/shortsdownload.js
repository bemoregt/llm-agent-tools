(function () {
  var status = document.getElementById('shortsdownload-status');
  var btn = document.getElementById('shortsdownload-btn');
  if (!btn) return;

  var currentMatch = location.pathname.match(/^\/page\/([^/]+)$/);
  var currentName = currentMatch ? decodeURIComponent(currentMatch[1]) : null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  btn.addEventListener('click', function () {
    if (!currentName) return;
    btn.disabled = true;
    setStatus('쇼츠 영상을 다운로드하는 중입니다...');

    fetch('/page/' + encodeURIComponent(currentName) + '/download-shorts', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || '쇼츠 영상 다운로드 실패');
          return data;
        });
      })
      .then(function () {
        location.reload();
      })
      .catch(function (err) {
        setStatus(err.message || '쇼츠 영상 다운로드에 실패했습니다.');
        btn.disabled = false;
      });
  });
})();
