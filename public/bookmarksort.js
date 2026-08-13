(() => {
  // Track clicks on external bookmark links so the sidebar sort button has
  // frequency data to work with. Fire-and-forget: a failed beacon shouldn't
  // block the link from opening in its new tab.
  const pageBody = document.querySelector('.page-body');
  if (pageBody) {
    pageBody.addEventListener('click', (e) => {
      const link = e.target.closest('a.external-link');
      if (!link) return;
      const url = link.getAttribute('href');
      if (!url) return;

      const payload = JSON.stringify({ url });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/link-click', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/link-click', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    });
  }

  const sortBtn = document.getElementById('bookmark-sort-btn');
  const statusEl = document.getElementById('bookmark-sort-status');
  if (!sortBtn) return;

  sortBtn.addEventListener('click', async () => {
    sortBtn.disabled = true;
    if (statusEl) statusEl.textContent = '정렬 중…';
    try {
      const res = await fetch(`/page/${sortBtn.dataset.page}/reorder-bookmarks`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '정렬 실패');

      if (data.reordered === 0) {
        if (statusEl) statusEl.textContent = 'ℹ️ 정렬할 북마크 목록이 없습니다';
        sortBtn.disabled = false;
        return;
      }

      if (statusEl) statusEl.textContent = `✅ ${data.reordered}개 링크 정렬 완료`;
      location.reload();
    } catch (err) {
      if (statusEl) statusEl.textContent = `❌ ${err.message}`;
      sortBtn.disabled = false;
    }
  });
})();
