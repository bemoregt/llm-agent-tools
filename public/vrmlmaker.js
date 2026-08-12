(function () {
  var btn = document.getElementById('vrml-btn');
  var status = document.getElementById('vrml-status');
  if (!btn) return;

  var currentMatch = location.pathname.match(/^\/page\/([^/]+)$/);
  var currentName = currentMatch ? decodeURIComponent(currentMatch[1]) : null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  btn.addEventListener('click', function () {
    if (!currentName) return;
    btn.disabled = true;
    setStatus('AI가 문서의 텍스트를 읽고 VRML 장면을 만드는 중입니다...');

    fetch('/page/' + encodeURIComponent(currentName) + '/vrml-generate', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || 'VRML 생성 실패');
          return data;
        });
      })
      .then(function () {
        location.reload();
      })
      .catch(function (err) {
        setStatus(err.message || 'VRML 생성에 실패했습니다.');
        btn.disabled = false;
      });
  });
})();
