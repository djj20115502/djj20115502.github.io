(function () {
  'use strict';
  var root = document.documentElement;

  /* ---------- 深色模式切换 ---------- */
  var toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = root.getAttribute('data-theme') ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  }

  /* ---------- 文章页：目录、锚点、复制按钮、阅读时长 ---------- */
  var body = document.getElementById('post-body');
  if (body) {
    // 旧文章里遗留的 [TOC] 标记（kramdown 不支持），直接移除
    Array.prototype.forEach.call(body.querySelectorAll('p'), function (p) {
      if (p.textContent.trim() === '[TOC]') p.remove();
    });

    // 正文第一行如果是和标题重复的 h1，去掉
    var first = body.firstElementChild;
    var titleEl = document.querySelector('.post-title');
    if (first && first.tagName === 'H1' && titleEl && first.textContent.trim() === titleEl.textContent.trim()) first.remove();

    // 旧文章用 # 写小节，新文章用 ##，目录取正文里实际出现的最高两级标题
    var levels = ['H1', 'H2', 'H3', 'H4'].filter(function (t) { return body.querySelector(t); }).slice(0, 2);
    var headings = levels.length ? body.querySelectorAll(levels.join(',')) : [];
    var used = {};
    Array.prototype.forEach.call(headings, function (h, i) {
      var id = h.id && !used[h.id] ? h.id : 'h-' + (i + 1);
      h.id = id;
      used[id] = true;
      var a = document.createElement('a');
      a.className = 'anchor';
      a.href = '#' + id;
      a.textContent = '#';
      a.setAttribute('aria-hidden', 'true');
      h.insertBefore(a, h.firstChild);
    });

    var toc = document.getElementById('toc');
    if (toc && headings.length >= 3) {
      var nav = toc.querySelector('nav');
      Array.prototype.forEach.call(headings, function (h) {
        var a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent.replace(/^#/, '').trim();
        a.className = h.tagName === levels[0] ? 'lv1' : 'lv2';
        nav.appendChild(a);
      });
      toc.hidden = false;
      var links = nav.querySelectorAll('a');
      var onScroll = function () {
        var active = 0;
        Array.prototype.forEach.call(headings, function (h, i) {
          if (h.getBoundingClientRect().top < 120) active = i;
        });
        Array.prototype.forEach.call(links, function (a, i) {
          a.classList.toggle('active', i === active);
        });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    Array.prototype.forEach.call(body.querySelectorAll('pre'), function (pre) {
      var host = pre.closest('.highlighter-rouge, figure.highlight') || pre;
      host.classList.add('copy-wrap');
      if (host === pre) pre.style.position = 'relative';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.textContent = '复制';
      btn.addEventListener('click', function () {
        var text = pre.innerText;
        var done = function () {
          btn.textContent = '已复制';
          setTimeout(function () { btn.textContent = '复制'; }, 1500);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done);
      });
      host.appendChild(btn);
    });

    var rt = document.querySelector('.reading-time');
    if (rt) {
      var chars = body.textContent.replace(/\s+/g, '').length;
      rt.textContent = '约 ' + Math.max(1, Math.round(chars / 500)) + ' 分钟读完';
      rt.hidden = false;
    }
  }

  /* ---------- 文章列表：分类筛选 + 搜索 ---------- */
  var archive = document.getElementById('archive');
  if (archive) {
    var input = document.getElementById('search');
    var filters = document.getElementById('filters');
    var empty = document.getElementById('empty');
    var items = archive.querySelectorAll('.post-item');
    var index = null;
    var cat = '';

    var apply = function () {
      var q = (input.value || '').trim().toLowerCase();
      var shown = 0;
      Array.prototype.forEach.call(items, function (li) {
        var ok = !cat || li.getAttribute('data-cat') === cat;
        if (ok && q) {
          var text = li.textContent.toLowerCase();
          var full = index && index[li.getAttribute('data-url')];
          ok = text.indexOf(q) >= 0 || (full && full.indexOf(q) >= 0);
        }
        li.hidden = !ok;
        if (ok) shown++;
      });
      Array.prototype.forEach.call(archive.querySelectorAll('.year-group'), function (g) {
        g.hidden = !g.querySelector('.post-item:not([hidden])');
      });
      empty.hidden = shown > 0;
    };

    var setCat = function (c) {
      cat = c;
      Array.prototype.forEach.call(filters.querySelectorAll('.chip-btn'), function (b) {
        b.classList.toggle('active', b.getAttribute('data-cat') === c);
      });
      apply();
    };

    filters.addEventListener('click', function (e) {
      var b = e.target.closest('.chip-btn');
      if (!b) return;
      var c = b.getAttribute('data-cat');
      history.replaceState(null, '', c ? '#' + encodeURIComponent(c) : location.pathname);
      setCat(c);
    });

    input.addEventListener('input', function () {
      if (!index) {
        index = {};
        fetch(archive.getAttribute('data-search-index'))
          .then(function (r) { return r.json(); })
          .then(function (list) {
            list.forEach(function (p) { index[p.url] = (p.title + ' ' + p.text).toLowerCase(); });
            apply();
          })
          .catch(function () {});
      }
      apply();
    });

    if (location.hash) {
      try { setCat(decodeURIComponent(location.hash.slice(1))); } catch (e) {}
    }
  }
})();
