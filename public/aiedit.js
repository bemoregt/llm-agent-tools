(function () {
  var btn = document.getElementById('aiedit-btn');
  var input = document.getElementById('aiedit-input');
  var status = document.getElementById('aiedit-status');
  if (!btn || !input) return;

  var currentMatch = location.pathname.match(/^\/page\/([^/]+)$/);
  var currentName = currentMatch ? decodeURIComponent(currentMatch[1]) : null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function submit() {
    var instruction = input.value.trim();
    if (!currentName || !instruction) return;
    btn.disabled = true;
    input.disabled = true;
    setStatus('AI가 지시에 따라 문서 내용을 수정하는 중입니다...');

    fetch('/page/' + encodeURIComponent(currentName) + '/ai-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: instruction }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || 'AI 수정 실패');
          return data;
        });
      })
      .then(function () {
        location.reload();
      })
      .catch(function (err) {
        setStatus(err.message || 'AI 수정에 실패했습니다.');
        btn.disabled = false;
        input.disabled = false;
      });
  }

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) {
    // Enter alone inserts a newline (this is now a multi-line textarea);
    // Cmd/Ctrl+Enter submits, matching the usual multi-line chat-box convention.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
})();
