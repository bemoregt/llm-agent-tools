(function () {
  var STACK_KEY = 'wikiNavStack';
  var currentMatch = location.pathname.match(/^\/page\/([^/]+)$/);
  var currentName = currentMatch ? decodeURIComponent(currentMatch[1]) : null;

  function getStack() {
    try {
      var raw = sessionStorage.getItem(STACK_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function setStack(arr) {
    try {
      sessionStorage.setItem(STACK_KEY, JSON.stringify(arr));
    } catch (e) {}
  }

  function pushCurrent() {
    if (!currentName) return;
    var stack = getStack();
    stack.push(currentName);
    setStack(stack);
  }

  // Leaving this page - whether by clicking a wiki-link/calendar day inside
  // the content, or by using a sidebar tool (히스토리/모든 페이지/검색/도움말) -
  // remembers this page so whatever page you land on can offer a way back to
  // it. This is a real stack (not a per-target "last parent" map), so A <-> B
  // mutual links can't turn the up-button into an infinite ping-pong loop -
  // each hop is pushed once and only popped when actually followed back.
  // Edit/view-mode switching for the SAME page is exempt: that round trip
  // must not push this page as its own parent.
  document.querySelectorAll('.page-body a.wikilink, .page-body a.wikilink-new, table.calendar td a').forEach(function (a) {
    a.addEventListener('click', function () {
      var m = a.getAttribute('href').match(/^\/(?:page|new)\/([^/?]+)/);
      if (!m) return;
      var targetName = decodeURIComponent(m[1]);
      if (targetName === currentName) return;
      pushCurrent();
    });
  });

  // Wiki-link text is selectable (see style.css) so a sentence containing a
  // link can be copied whole. That reopens the problem the old
  // `user-select: none` rule used to paper over: a tiny cursor drift while
  // clicking (common on trackpads) makes the browser start a text selection
  // instead of firing `click`, so the link silently fails to navigate. This
  // restores that reliability without disabling selection: if the mouse
  // moved between down and up but the drift didn't actually select any
  // text, the native click never happens on its own, so it's forced here.
  // A drift that *did* select real text is left alone so the user can copy it.
  (function () {
    var linkSelector = '.page-body a.wikilink, .page-body a.wikilink-new';
    var down = null;

    document.addEventListener('mousedown', function (e) {
      var link = e.target.closest(linkSelector);
      down = link ? { link: link, clicked: false } : null;
    });

    // Capture phase so this always sees the click before other listeners
    // (e.g. the pushCurrent one above) get a chance to run/return early.
    document.addEventListener('click', function (e) {
      if (down && e.target.closest(linkSelector) === down.link) down.clicked = true;
    }, true);

    document.addEventListener('mouseup', function (e) {
      var info = down;
      if (!info || e.target.closest(linkSelector) !== info.link) { down = null; return; }
      var sel = window.getSelection();
      var hasSelection = !!sel && sel.toString().length > 0;
      // Deferred: a genuine click fires synchronously right after mouseup,
      // so by the time this runs, info.clicked already reflects whether it did.
      setTimeout(function () {
        if (!hasSelection && !info.clicked) info.link.click();
        down = null;
      }, 0);
    });
  })();

  document.querySelectorAll('.sidebar a').forEach(function (a) {
    if (a.closest('.page-mode-actions')) return;
    a.addEventListener('click', pushCurrent);
  });

  var searchForm = document.querySelector('.side-section form[action="/search"]');
  if (searchForm) searchForm.addEventListener('submit', pushCurrent);

  // Fallback for when sessionStorage has nothing (e.g. opened in a new tab):
  // only a genuine wiki-page referrer counts as a parent page.
  function parentFromReferrer() {
    if (!document.referrer) return null;
    try {
      var ref = new URL(document.referrer);
      if (ref.origin !== location.origin) return null;
      var pageMatch = ref.pathname.match(/^\/page\/([^/]+)$/);
      if (!pageMatch) return null;
      var name = decodeURIComponent(pageMatch[1]);
      return name === currentName ? null : name;
    } catch (e) {
      return null;
    }
  }

  var upBtn = document.getElementById('up-btn');
  if (!upBtn || !currentName) return;

  var stack = getStack();
  var parentName = stack.length ? stack[stack.length - 1] : null;
  var poppable = Boolean(parentName && parentName !== currentName);
  if (!poppable) parentName = parentFromReferrer();

  if (!parentName || parentName === currentName) return;

  upBtn.href = '/page/' + encodeURIComponent(parentName);
  upBtn.textContent = '↑ 상위 페이지 보기: ' + parentName;
  upBtn.style.display = '';
  upBtn.addEventListener('click', function () {
    if (!poppable) return;
    // Consume this hop so the trail doesn't dangle behind after going back.
    var s = getStack();
    s.pop();
    setStack(s);
  });
})();
