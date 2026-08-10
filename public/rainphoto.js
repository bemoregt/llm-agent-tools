(function () {
  var btn = document.getElementById('rainphoto-btn');
  var status = document.getElementById('rainphoto-status');
  if (!btn) return;

  var currentMatch = location.pathname.match(/^\/page\/([^/]+)$/);
  var currentName = currentMatch ? decodeURIComponent(currentMatch[1]) : null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  btn.addEventListener('click', function () {
    if (!currentName) return;
    btn.disabled = true;
    setStatus('windy.com에서 비구름 사진을 캡처하는 중입니다 (수십 초 정도 걸립니다)...');

    fetch('/page/' + encodeURIComponent(currentName) + '/rain-photo', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || '비구름 사진 첨부 실패');
          return data;
        });
      })
      .then(function () {
        location.reload();
      })
      .catch(function (err) {
        setStatus(err.message || '비구름 사진 첨부에 실패했습니다.');
        btn.disabled = false;
      });
  });
})();
