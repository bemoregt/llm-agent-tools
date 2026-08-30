(function () {
  var btn = document.getElementById('torrentdownload-btn');
  var status = document.getElementById('torrentdownload-status');
  var progressBox = document.getElementById('torrentdownload-progress');
  var fill = document.getElementById('torrentdownload-bar-fill');
  var progressText = document.getElementById('torrentdownload-progress-text');
  if (!btn) return;

  var currentMatch = location.pathname.match(/^\/page\/([^/]+)$/);
  var currentName = currentMatch ? decodeURIComponent(currentMatch[1]) : null;

  var pollTimer = null;
  var postDone = false;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function renderProgress() {
    fetch('/api/torrent-progress/' + encodeURIComponent(currentName))
      .then(function (r) { return r.json(); })
      .then(function (p) {
        var pct = Math.max(0, Math.min(100, Math.round((p.percent || 0) * 100)));

        if (!progressBox) return;
        progressBox.style.display = 'block';

        if (fill) {
          fill.style.width = (p.status === 'preparing' || p.status === 'copying') ? '100%' : pct + '%';
        }

        var msg = '';
        switch (p.status) {
          case 'preparing':
          case 'copying':
            msg = (p.message || '처리 중...');
            break;
          case 'downloading':
            msg = (p.fileName ? p.fileName + ': ' : '') +
              pct + '% ' +
              '(' + fmtBytes(p.downloaded) + ' / ' + fmtBytes(p.length) + ')' +
              (p.speed ? ' · ' + fmtBytes(p.speed) + '/s' : '') +
              (typeof p.peers === 'number' ? ' · 피어 ' + p.peers : '') +
              (pct === 0 ? ' (피어 탐색 중...)' : '');
            break;
          default:
            msg = p.message || p.status || '';
        }
        if (progressText) progressText.textContent = msg;
      })
      .catch(function () { /* transient poll error - ignore */ });
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  btn.addEventListener('click', function () {
    if (!currentName) return;
    btn.disabled = true;
    postDone = false;
    setStatus('');
    if (progressBox) progressBox.style.display = 'block';
    if (fill) fill.style.width = '0%';
    if (progressText) progressText.textContent = '토런트 분석을 시작합니다...';
    renderProgress();
    pollTimer = setInterval(renderProgress, 900);

    fetch('/page/' + encodeURIComponent(currentName) + '/torrent-download', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || '토런트 다운로드 실패');
          return data;
        });
      })
      .then(function () {
        if (postDone) return; /* already handled below */
        postDone = true;
        stopPolling();
        location.reload();
      })
      .catch(function (err) {
        if (postDone) return;
        postDone = true;
        stopPolling();
        setStatus(err.message || '토런트 다운로드에 실패했습니다.');
        btn.disabled = false;
      });
  });
})();