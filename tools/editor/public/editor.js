(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  /* ---------------- API ---------------- */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'X-Blog-Editor': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
    return data;
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'ed-toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 4000 : 2000);
  }

  /* ---------------- State ---------------- */
  const state = {
    posts: [],
    categories: [],
    changed: new Set(),   // git 有改动的文件
    current: null,        // { path, mtime, isNew }
    savedSnapshot: '',
    slugTouched: false,
    filter: '',
  };

  const fields = ['title', 'category', 'date', 'tags', 'intro', 'slug', 'cover'];
  const f = {};
  fields.forEach(k => { f[k] = $('f-' + k); });
  f.draft = $('f-draft');

  /* ---------------- CodeMirror ---------------- */
  const cm = CodeMirror.fromTextArea($('f-body'), {
    mode: { name: 'gfm', highlightFormatting: true, fencedCodeBlockHighlighting: false },
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
    extraKeys: {
      'Enter': 'newlineAndIndentContinueMarkdownList',
      'Tab': c => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  '),
      'Shift-Tab': c => c.indentSelection('subtract'),
      'Ctrl-B': () => command('bold'), 'Cmd-B': () => command('bold'),
      'Ctrl-I': () => command('italic'), 'Cmd-I': () => command('italic'),
      'Ctrl-K': () => command('link'), 'Cmd-K': () => command('link'),
    },
  });

  /* ---------------- Preview ---------------- */
  marked.setOptions({ gfm: true, breaks: false });
  const renderer = new marked.Renderer();
  renderer.code = function (code, lang) {
    let html;
    const l = (lang || '').trim().split(/\s+/)[0];
    try {
      html = l && hljs.getLanguage(l) ? hljs.highlight(code, { language: l }).value : esc(code);
    } catch (e) { html = esc(code); }
    return `<div class="highlighter-rouge"><div class="highlight"><pre class="highlight"><code>${html}</code></pre></div></div>`;
  };
  marked.use({ renderer });

  const frame = $('preview');
  frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/assets/css/main.css">
    <style>body{display:block;min-height:0}.post{padding-top:32px;padding-bottom:80px}</style></head>
    <body><article class="post wrap">
      <header class="post-header">
        <div class="post-meta"><span class="chip" id="p-cat"></span><time id="p-date"></time><span id="p-draft" class="chip" style="background:none;border:1px dashed currentColor">草稿</span></div>
        <h1 class="post-title" id="p-title"></h1>
        <p class="post-lede" id="p-intro"></p>
        <div class="post-tags" id="p-tags"></div>
      </header>
      <img class="post-cover" id="p-cover" alt="">
      <div class="prose" id="p-body"></div>
    </article></body></html>`;

  let previewTimer;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 120);
  }

  function renderPreview() {
    const doc = frame.contentDocument;
    if (!doc || !doc.getElementById('p-body')) return;
    syncPreviewTheme();
    const set = (id, text) => { const el = doc.getElementById(id); el.textContent = text; el.hidden = !text; };
    set('p-cat', f.category.value.trim() || '未分类');
    const d = f.date.value || today();
    set('p-date', d.replace(/^(\d+)-(\d+)-(\d+)$/, '$1 年 $2 月 $3 日'));
    set('p-title', f.title.value.trim() || '未命名');
    set('p-intro', f.intro.value.trim());
    doc.getElementById('p-draft').hidden = !f.draft.checked;
    const tags = parseTags(f.tags.value);
    const tagsEl = doc.getElementById('p-tags');
    tagsEl.innerHTML = tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('');
    tagsEl.hidden = !tags.length;
    const cover = doc.getElementById('p-cover');
    cover.hidden = !f.cover.value.trim();
    if (!cover.hidden) cover.src = f.cover.value.trim();
    const bodyEl = doc.getElementById('p-body');
    bodyEl.innerHTML = marked.parse(cm.getValue());
    // 与线上一致：正文开头和标题重复的 h1 不显示
    const first = bodyEl.firstElementChild;
    if (first && first.tagName === 'H1' && first.textContent.trim() === doc.getElementById('p-title').textContent.trim()) first.remove();
  }

  function syncPreviewTheme() {
    const doc = frame.contentDocument;
    if (!doc) return;
    const t = document.documentElement.getAttribute('data-theme');
    if (t) doc.documentElement.setAttribute('data-theme', t);
    else doc.documentElement.removeAttribute('data-theme');
  }

  frame.addEventListener('load', renderPreview);

  // 编辑区滚动时，预览按比例跟随
  cm.on('scroll', () => {
    const win = frame.contentWindow;
    if (!win || $('panes').className.indexOf('view-split') < 0) return;
    const info = cm.getScrollInfo();
    const ratio = info.top / Math.max(1, info.height - info.clientHeight);
    const de = win.document.documentElement;
    win.scrollTo(0, ratio * (de.scrollHeight - de.clientHeight));
  });

  /* ---------------- Snapshot / dirty ---------------- */
  function parseTags(s) { return String(s || '').split(/[,，]/).map(t => t.trim()).filter(Boolean); }

  function formData() {
    return {
      title: f.title.value.trim(),
      category: f.category.value.trim(),
      date: f.date.value,
      tags: parseTags(f.tags.value),
      intro: f.intro.value.trim(),
      slug: f.slug.value.trim(),
      cover: f.cover.value.trim(),
      draft: f.draft.checked,
      body: cm.getValue(),
    };
  }
  const snapshot = () => JSON.stringify(formData());
  const isDirty = () => state.current && snapshot() !== state.savedSnapshot;

  function updateDirty() {
    const dirty = isDirty();
    const el = $('st-save');
    el.textContent = dirty ? '未保存' : (state.current && state.current.isNew ? '新文章' : '已保存');
    el.classList.toggle('dirty', !!dirty);
    document.title = (dirty ? '● ' : '') + (f.title.value.trim() || '博客编辑器');
    const chars = cm.getValue().replace(/\s+/g, '').length;
    $('st-count').textContent = `${chars} 字`;
    if (state.current) {
      const backupKey = 'draft:' + (state.current.path || '__new__');
      try {
        if (dirty) localStorage.setItem(backupKey, snapshot());
        else localStorage.removeItem(backupKey);
      } catch (e) {}
    }
    updatePathHint();
  }

  function slugify(s) {
    return String(s || '').trim().replace(/[\\/:*?"<>|#%&{}$!'@`+=^~\[\];,]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  }

  function updatePathHint() {
    if (!state.current) return;
    const d = formData();
    const slug = slugify(d.slug || d.title) || 'untitled';
    const p = `_posts/${d.category ? d.category.replace(/[\\/:*?"<>|]/g, '') + '/' : ''}${d.date || today()}-${slug}.md`;
    const el = $('st-path');
    el.textContent = p;
    el.title = state.current.path && state.current.path !== p ? `保存后将从 ${state.current.path} 重命名` : '';
  }

  /* ---------------- Post list ---------------- */
  async function loadPosts() {
    const [list, git] = await Promise.all([
      api('GET', '/api/posts'),
      api('GET', '/api/git/status').catch(() => null),
    ]);
    state.posts = list.posts;
    state.categories = list.categories;
    $('category-list').innerHTML = state.categories.map(c => `<option value="${esc(c)}">`).join('');
    if (git) {
      state.changed = new Set(git.files.map(x => x.path));
      const n = git.files.length;
      $('change-count').textContent = n;
      $('change-count').hidden = !n;
      $('git-branch').textContent = '⎇ ' + git.branch;
    }
    renderList();
  }

  function renderList() {
    const q = state.filter.toLowerCase();
    const posts = state.posts.filter(p => !q || (p.title + ' ' + p.intro + ' ' + p.category + ' ' + p.tags.join(' ')).toLowerCase().includes(q));
    const groups = new Map();
    posts.forEach(p => {
      const k = p.category || '未分类';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    });
    const cur = state.current && state.current.path;
    let html = '';
    for (const [cat, items] of groups) {
      html += `<div class="ed-group"><div class="ed-group-title"><span>${esc(cat)}</span><span>${items.length}</span></div>`;
      for (const p of items) {
        html += `<button class="ed-post${p.path === cur ? ' active' : ''}" data-path="${esc(p.path)}">
          <span class="ed-post-title">${esc(p.title)}</span>
          <span class="ed-post-meta"><span>${esc(p.date)}</span>${p.draft ? '<span class="ed-tag-draft">草稿</span>' : ''}</span>
          ${state.changed.has(p.path) ? '<span class="dot" title="有未发布的改动"></span>' : ''}
        </button>`;
      }
      html += '</div>';
    }
    $('post-list').innerHTML = html || `<div class="ed-none">${q ? '没有匹配的文章' : '还没有文章'}</div>`;
  }

  $('post-list').addEventListener('click', e => {
    const b = e.target.closest('.ed-post');
    if (b) openPost(b.getAttribute('data-path'));
  });
  $('post-search').addEventListener('input', e => { state.filter = e.target.value.trim(); renderList(); });

  /* ---------------- Open / new / save / delete ---------------- */
  function confirmDiscard() {
    return !isDirty() || confirm('当前文章有未保存的修改，确定要放弃吗？');
  }

  function fill(d) {
    f.title.value = d.title || '';
    f.category.value = d.category || '';
    f.date.value = d.date || today();
    f.tags.value = (d.tags || []).join(', ');
    f.intro.value = d.intro || '';
    f.slug.value = d.slug || '';
    f.cover.value = d.cover || '';
    f.draft.checked = !!d.draft;
    cm.setValue(d.body || '');
    cm.clearHistory();
  }

  function showDoc() {
    $('empty-state').hidden = true;
    $('doc').hidden = false;
    setTimeout(() => cm.refresh(), 0);
  }

  function maybeRestore(key) {
    try {
      const raw = localStorage.getItem('draft:' + key);
      if (raw && raw !== state.savedSnapshot && confirm('发现这篇文章有上次未保存的内容，要恢复吗？')) {
        fill(JSON.parse(raw));
      } else if (raw) localStorage.removeItem('draft:' + key);
    } catch (e) {}
  }

  async function openPost(p) {
    if (state.current && state.current.path === p) return;
    if (!confirmDiscard()) return;
    try {
      const d = await api('GET', '/api/post?path=' + encodeURIComponent(p));
      state.current = { path: d.path, mtime: d.mtime, isNew: false };
      fill(d);
      state.savedSnapshot = snapshot();
      state.slugTouched = true;
      maybeRestore(d.path);
      showDoc();
      renderList();
      updateDirty();
      renderPreview();
      try { localStorage.setItem('lastPost', d.path); } catch (e) {}
    } catch (e) { toast('打开失败：' + e.message, true); }
  }

  function newPost() {
    if (!confirmDiscard()) return;
    const prevCategory = state.current ? f.category.value.trim() : '';
    state.current = { path: null, mtime: 0, isNew: true };
    fill({ date: today(), category: prevCategory, body: '' });
    state.savedSnapshot = snapshot();
    state.slugTouched = false;
    maybeRestore('__new__');
    showDoc();
    renderList();
    updateDirty();
    renderPreview();
    f.title.focus();
  }

  async function save(force) {
    if (!state.current) return;
    const d = formData();
    if (!d.title) { toast('请先填写标题', true); f.title.focus(); return; }
    try {
      const res = await api('POST', '/api/post', {
        ...d,
        path: state.current.path,
        expectedMtime: state.current.mtime,
        force: !!force,
      });
      try { localStorage.removeItem('draft:' + (state.current.path || '__new__')); } catch (e) {}
      const renamed = state.current.path && state.current.path !== res.path;
      state.current = { path: res.path, mtime: res.mtime, isNew: false };
      state.savedSnapshot = snapshot();
      updateDirty();
      await loadPosts();
      toast(renamed ? '已保存并重命名' : '已保存');
      try { localStorage.setItem('lastPost', res.path); } catch (e) {}
    } catch (e) {
      if (e.status === 409 && /外被修改/.test(e.message)) {
        if (confirm(e.message + '\n\n点“确定”用编辑器里的内容覆盖。')) return save(true);
      } else toast('保存失败：' + e.message, true);
    }
  }

  async function removePost() {
    if (!state.current) return;
    if (state.current.isNew) { state.current = null; showEmpty(); return; }
    if (!confirm(`确定删除「${f.title.value || state.current.path}」吗？\n删除后发布才会同步到 GitHub，在那之前可以用 git 恢复。`)) return;
    try {
      await api('DELETE', '/api/post?path=' + encodeURIComponent(state.current.path));
      try { localStorage.removeItem('draft:' + state.current.path); } catch (e) {}
      state.current = null;
      showEmpty();
      await loadPosts();
      toast('已删除');
    } catch (e) { toast('删除失败：' + e.message, true); }
  }

  function showEmpty() {
    $('doc').hidden = true;
    $('empty-state').hidden = false;
    document.title = '博客编辑器';
    renderList();
  }

  $('btn-new').addEventListener('click', newPost);
  $('empty-new').addEventListener('click', e => { e.preventDefault(); newPost(); });
  $('btn-delete').addEventListener('click', removePost);

  fields.concat(['draft']).forEach(k => {
    f[k].addEventListener('input', () => {
      if (k === 'slug') state.slugTouched = !!f.slug.value.trim();
      updateDirty();
      schedulePreview();
    });
  });
  cm.on('change', () => { updateDirty(); schedulePreview(); });

  /* ---------------- Toolbar commands ---------------- */
  function wrap(before, after, placeholder) {
    const sel = cm.getSelection() || placeholder;
    cm.replaceSelection(before + sel + after);
    if (!cm.getSelection()) {
      const c = cm.getCursor();
      cm.setSelection({ line: c.line, ch: c.ch - after.length - sel.length }, { line: c.line, ch: c.ch - after.length });
    }
    cm.focus();
  }

  function linePrefix(prefix) {
    const from = cm.getCursor('from').line;
    const to = cm.getCursor('to').line;
    cm.operation(() => {
      for (let i = from; i <= to; i++) {
        const text = cm.getLine(i);
        const stripped = text.replace(/^(#{1,6}\s+|>\s?|[-*]\s+)/, '');
        const next = text.startsWith(prefix) ? stripped : prefix + stripped;
        cm.replaceRange(next, { line: i, ch: 0 }, { line: i, ch: text.length });
      }
    });
    cm.focus();
  }

  function insertBlock(text) {
    const c = cm.getCursor();
    const line = cm.getLine(c.line);
    const pre = line.trim() ? '\n\n' : '';
    cm.replaceRange(pre + text + '\n', { line: c.line, ch: line.length });
    cm.focus();
  }

  function command(name) {
    switch (name) {
      case 'h2': return linePrefix('## ');
      case 'h3': return linePrefix('### ');
      case 'bold': return wrap('**', '**', '加粗文字');
      case 'italic': return wrap('*', '*', '斜体文字');
      case 'code': return wrap('`', '`', 'code');
      case 'quote': return linePrefix('> ');
      case 'ul': return linePrefix('- ');
      case 'link': {
        const sel = cm.getSelection();
        if (/^https?:\/\//.test(sel)) return wrap('[链接文字](', ')', '');
        return wrap('[', '](https://)', '链接文字');
      }
      case 'image': return $('file-input').click();
      case 'codeblock': {
        const sel = cm.getSelection();
        if (sel) { cm.replaceSelection('```\n' + sel + '\n```'); cm.focus(); return; }
        insertBlock('```java\n\n```');
        const c = cm.getCursor();
        cm.setCursor({ line: c.line - 2, ch: 0 });
        return;
      }
      case 'table': return insertBlock('| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |');
    }
  }

  $('toolbar').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.cmd) command(b.dataset.cmd);
    if (b.dataset.view) setView(b.dataset.view);
  });

  function setView(v) {
    $('panes').className = 'ed-panes view-' + v;
    document.querySelectorAll('.ed-views button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    try { localStorage.setItem('view', v); } catch (e) {}
    setTimeout(() => cm.refresh(), 0);
    renderPreview();
  }

  /* ---------------- Images ---------------- */
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function uploadFiles(files) {
    const imgs = Array.from(files).filter(x => /^image\//.test(x.type));
    if (!imgs.length) return;
    if (!state.current) { toast('请先打开或新建一篇文章', true); return; }
    for (const file of imgs) {
      const mark = `![上传中 ${file.name || 'image'}…]()`;
      cm.replaceSelection(mark);
      try {
        const res = await api('POST', '/api/upload', { name: file.name || 'paste', data: await readAsDataURL(file) });
        const alt = (file.name || '').replace(/\.[^.]+$/, '').replace(/^image$/, '') || '图片';
        replaceText(mark, `![${alt}](${res.url})`);
      } catch (e) {
        replaceText(mark, '');
        toast('图片上传失败：' + e.message, true);
      }
    }
  }

  function replaceText(from, to) {
    const idx = cm.getValue().indexOf(from);
    if (idx >= 0) cm.replaceRange(to, cm.posFromIndex(idx), cm.posFromIndex(idx + from.length));
  }

  cm.on('paste', (_, e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length && Array.from(files).some(x => /^image\//.test(x.type))) {
      e.preventDefault();
      uploadFiles(files);
    }
  });

  const zone = $('drop-zone');
  let dragDepth = 0;
  zone.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; zone.classList.add('dragging'); } });
  zone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove('dragging'); } });
  zone.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  zone.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    zone.classList.remove('dragging');
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY });
    cm.setCursor(pos);
    uploadFiles(e.dataTransfer.files);
  }, true);
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  $('file-input').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = ''; });

  /* ---------------- Git ---------------- */
  const dlg = $('publish-dialog');
  const CONTENT = /^(_posts\/|assets\/uploads\/)/;

  async function openPublish() {
    if (isDirty()) {
      if (!confirm('当前文章还没保存，先保存再发布？')) return;
      await save();
      if (isDirty()) return;
    }
    const log = $('pub-log');
    log.hidden = true;
    log.className = 'ed-log';
    $('pub-go').disabled = false;
    $('pub-all').checked = false;
    let st;
    try { st = await api('GET', '/api/git/status'); }
    catch (e) { toast('读取 git 状态失败：' + e.message, true); return; }
    $('pub-branch').textContent = '分支：' + st.branch;
    renderChanges(st.files);
    $('pub-all').onchange = () => renderChanges(st.files);

    const titles = st.files.filter(x => /^_posts\//.test(x.path)).map(x => {
      const p = state.posts.find(pp => pp.path === x.path);
      return p ? p.title : x.path.split('/').pop().replace(/^\d+-\d+-\d+-|\.md$/g, '');
    });
    $('pub-message').value = titles.length ? '更新文章：' + titles.slice(0, 3).join('、') + (titles.length > 3 ? ' 等' : '') : '更新博客';
    dlg.showModal();
  }

  function renderChanges(files) {
    const all = $('pub-all').checked;
    const box = $('pub-files');
    if (!files.length) { box.innerHTML = '<div>没有改动，可以直接推送已有的提交。</div>'; return; }
    const names = { 'M': '改', 'A': '新', 'D': '删', 'R': '名', '?': '新' };
    box.innerHTML = files.map(x => {
      const inScope = all || CONTENT.test(x.path);
      const code = x.code.trim()[0] || '?';
      return `<div class="${inScope ? '' : 'outside'}" title="${inScope ? '' : '不在本次提交范围内'}"><b>${names[code] || code}</b>${esc(x.path)}</div>`;
    }).join('');
  }

  async function doPublish() {
    const go = $('pub-go');
    const log = $('pub-log');
    go.disabled = true;
    go.textContent = '推送中…';
    log.hidden = false;
    log.className = 'ed-log';
    log.textContent = '正在提交并推送，请稍候…';
    try {
      const r = await api('POST', '/api/git/publish', { message: $('pub-message').value, all: $('pub-all').checked });
      log.textContent = r.log + (r.ok ? '\n\n✓ 发布成功，GitHub Pages 通常 1 分钟内生效。' : '\n\n✗ 发布失败，请查看上方输出。');
      log.className = 'ed-log ' + (r.ok ? 'ok' : 'fail');
      if (r.ok) toast('发布成功');
    } catch (e) {
      log.textContent = e.message;
      log.className = 'ed-log fail';
    }
    go.textContent = '提交并推送';
    go.disabled = false;
    loadPosts();
  }

  $('btn-publish').addEventListener('click', openPublish);
  $('pub-go').addEventListener('click', doPublish);
  $('pub-cancel').addEventListener('click', () => dlg.close());

  $('btn-pull').addEventListener('click', async () => {
    const b = $('btn-pull');
    b.disabled = true;
    try {
      const r = await api('POST', '/api/git/pull');
      toast(r.ok ? '已拉取最新内容' : '拉取失败：' + r.log.split('\n').slice(-2).join(' '), !r.ok);
      await loadPosts();
    } catch (e) { toast('拉取失败：' + e.message, true); }
    b.disabled = false;
  });

  /* ---------------- Theme & keys ---------------- */
  $('btn-theme').addEventListener('click', () => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    syncPreviewTheme();
  });

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); newPost(); }
  });

  window.addEventListener('beforeunload', e => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // 新文章：根据标题自动生成文件名提示
  f.title.addEventListener('input', () => {
    if (!state.slugTouched && state.current && state.current.isNew) f.slug.placeholder = slugify(f.title.value) || '默认使用标题';
  });

  /* ---------------- Init ---------------- */
  (async function init() {
    let view = 'split';
    try { view = localStorage.getItem('view') || 'split'; } catch (e) {}
    setView(view);
    try {
      await loadPosts();
      let last = new URLSearchParams(location.search).get('path');
      try { last = last || localStorage.getItem('lastPost'); } catch (e) {}
      if (last && state.posts.some(p => p.path === last)) openPost(last);
    } catch (e) {
      toast('无法连接编辑器服务：' + e.message, true);
    }
  })();
})();
