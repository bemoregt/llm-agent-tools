(function () {
  var btn = document.getElementById('webcapture-btn');
  var status = document.getElementById('webcapture-status');
  if (!btn) return;

  var currentMatch = location.pathname.match(/^\/page\/([^/]+)$/);
  var currentName = currentMatch ? decodeURIComponent(currentMatch[1]) : null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  btn.addEventListener('click', function () {
    if (!currentName) return;
    btn.disabled = true;
    setStatus('문서 속 링크의 웹페이지를 스크롤하며 캡쳐하는 중입니다 (수십 초 정도 걸립니다)...');

    fetch('/page/' + encodeURIComponent(currentName) + '/web-capture', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || '웹페이지 캡쳐 실패');
          return data;
        });
      })
      .then(function () {
        location.reload();
      })
      .catch(function (err) {
        setStatus(err.message || '웹페이지 캡쳐에 실패했습니다.');
        btn.disabled = false;
      });
  });
})();
