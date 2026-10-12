#!/usr/bin/env node
/*
 * 本地博客编辑器服务端（零依赖，Node 18+）
 *   node tools/editor/server.js [--port 4567] [--no-open]
 * 只监听 127.0.0.1，文章读写限制在 _posts 目录，图片保存到 assets/uploads。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile, exec } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const POSTS = path.join(REPO, '_posts');
const UPLOADS = path.join(REPO, 'assets', 'uploads');
const PUBLIC = path.join(__dirname, 'public');

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || Number(process.env.PORT) || 4567;
const OPEN = !args.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/* ---------------- Front matter ---------------- */

// 只处理编辑器关心的字段，其余字段原样保留
const KNOWN = ['title', 'date', 'intro', 'tags', 'cover', 'published', 'layout'];

function unquote(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return v;
}

function parseList(v) {
  v = v.trim();
  if (!v) return [];
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  return v.split(',').map(unquote).map(s => s.trim()).filter(Boolean);
}

function parsePost(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const meta = { tags: [] };
  const extra = [];
  let body = text;
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (m) {
    body = text.slice(m[0].length);
    const lines = m[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const kv = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
      if (!kv || !KNOWN.includes(kv[1])) { extra.push(line); continue; }
      const key = kv[1];
      const val = kv[2];
      if (key === 'tags') {
        if (val.trim()) meta.tags = parseList(val);
        else {
          while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
            meta.tags.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
          }
        }
      } else if (key === 'published') {
        meta.published = val.trim() !== 'false';
      } else {
        meta[key] = unquote(val);
      }
    }
  }
  // 去掉 extra 首尾空行
  while (extra.length && !extra[extra.length - 1].trim()) extra.pop();
  return { meta, extra: extra.join('\n'), body: body.replace(/^\n+/, '') };
}

function yamlStr(s) {
  s = String(s == null ? '' : s);
  if (s === '') return '""';
  if (/^(true|false|null|yes|no|on|off|~|[-+]?[\d.]+)$/i.test(s)) return '"' + s + '"';
  if (/^[\w一-鿿　-〿＀-￯][^:#\n"'\[\]{},&*!|>%@`]*$/.test(s) && s.trim() === s) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function serializePost({ meta, extra, body }) {
  const out = ['---'];
  out.push('layout: ' + (meta.layout || 'post'));
  out.push('title: ' + yamlStr(meta.title || '未命名'));
  if (meta.date) out.push('date: ' + meta.date);
  if (meta.intro) out.push('intro: ' + yamlStr(meta.intro));
  if (meta.tags && meta.tags.length) out.push('tags: [' + meta.tags.map(yamlStr).join(', ') + ']');
  if (meta.cover) out.push('cover: ' + yamlStr(meta.cover));
  if (meta.published === false) out.push('published: false');
  if (extra && extra.trim()) out.push(extra.trimEnd());
  out.push('---', '');
  return out.join('\n') + (body || '').replace(/\r\n/g, '\n').replace(/\s*$/, '\n');
}

/* ---------------- Helpers ---------------- */

const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function slugify(s) {
  return String(s || '').trim()
    .replace(/[\\/:*?"<>|#%&{}$!'@`+=^~\[\];,]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'untitled';
}

function cleanSegment(s) {
  const v = String(s || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/^\.+/, '');
  return v.slice(0, 40);
}

// 把相对路径解析到 _posts 内，越界则抛错
function resolvePost(rel) {
  const abs = path.resolve(REPO, rel);
  const r = path.relative(POSTS, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r) || !/\.(md|markdown)$/i.test(abs)) {
    throw httpError(400, '非法的文章路径');
  }
  return abs;
}

const toRel = abs => path.relative(REPO, abs).split(path.sep).join('/');

function httpError(code, msg) { const e = new Error(msg); e.status = code; return e; }

async function walk(dir) {
  let out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await walk(p));
    else if (/\.(md|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function infoFromPath(abs) {
  const rel = path.relative(POSTS, abs).split(path.sep);
  const file = rel[rel.length - 1];
  const category = rel.length > 1 ? rel[0] : '';
  const m = file.match(/^(\d{4})-(\d{1,2})-(\d{1,2})-(.+)\.(md|markdown)$/i);
  return {
    category,
    fileDate: m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : '',
    slug: m ? m[4] : file.replace(/\.(md|markdown)$/i, ''),
  };
}

function git(argv) {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.quotepath=false', ...argv], { cwd: REPO, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(httpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(httpError(400, 'JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ---------------- API ---------------- */

async function listPosts() {
  const files = await walk(POSTS);
  const posts = await Promise.all(files.map(async abs => {
    const text = await fsp.readFile(abs, 'utf8');
    const { meta } = parsePost(text);
    const info = infoFromPath(abs);
    const stat = await fsp.stat(abs);
    return {
      path: toRel(abs),
      title: meta.title || info.slug,
      date: (meta.date || info.fileDate || '').slice(0, 10),
      category: info.category,
      intro: meta.intro || '',
      tags: meta.tags || [],
      draft: meta.published === false,
      mtime: stat.mtimeMs,
    };
  }));
  posts.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.mtime - a.mtime);
  const categories = [];
  try {
    for (const e of await fsp.readdir(POSTS, { withFileTypes: true })) if (e.isDirectory()) categories.push(e.name);
  } catch {}
  return { posts, categories };
}

async function getPost(rel) {
  const abs = resolvePost(rel);
  const text = await fsp.readFile(abs, 'utf8').catch(() => { throw httpError(404, '文章不存在'); });
  const { meta, extra, body } = parsePost(text);
  const info = infoFromPath(abs);
  return {
    path: toRel(abs),
    category: info.category,
    slug: info.slug,
    date: (meta.date || info.fileDate || today()).slice(0, 10),
    title: meta.title || '',
    intro: meta.intro || '',
    tags: meta.tags || [],
    cover: meta.cover || '',
    draft: meta.published === false,
    layout: meta.layout || 'post',
    extra,
    body,
  };
}

async function savePost(data) {
  const title = String(data.title || '').trim();
  if (!title) throw httpError(400, '标题不能为空');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : today();
  const category = cleanSegment(data.category);
  const slug = slugify(data.slug || title);
  const dir = category ? path.join(POSTS, category) : POSTS;
  const target = path.join(dir, `${date}-${slug}.md`);
  resolvePost(toRel(target));

  let oldAbs = null;
  let extra = '';
  if (data.path) {
    oldAbs = resolvePost(data.path);
    if (fs.existsSync(oldAbs)) extra = parsePost(await fsp.readFile(oldAbs, 'utf8')).extra;
    else oldAbs = null;
  }

  if (oldAbs && data.expectedMtime && fs.existsSync(oldAbs)) {
    const st = await fsp.stat(oldAbs);
    if (Math.abs(st.mtimeMs - data.expectedMtime) > 1 && !data.force) {
      throw httpError(409, '文件在编辑器外被修改过，请确认后再覆盖');
    }
  }
  const renaming = oldAbs && path.resolve(oldAbs).toLowerCase() !== path.resolve(target).toLowerCase();
  if ((!oldAbs || renaming) && fs.existsSync(target)) throw httpError(409, '同名文章已存在：' + toRel(target));

  const tags = Array.isArray(data.tags) ? data.tags : parseList(String(data.tags || ''));
  const text = serializePost({
    meta: {
      layout: data.layout || 'post',
      title, date, intro: String(data.intro || '').trim(),
      tags: tags.map(t => String(t).trim()).filter(Boolean),
      cover: String(data.cover || '').trim(),
      published: data.draft ? false : undefined,
    },
    extra,
    body: data.body || '',
  });

  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(target, text, 'utf8');
  if (renaming) {
    await fsp.unlink(oldAbs);
    const oldDir = path.dirname(oldAbs);
    if (oldDir !== POSTS && !(await fsp.readdir(oldDir)).length) await fsp.rmdir(oldDir);
  }
  const st = await fsp.stat(target);
  return { path: toRel(target), mtime: st.mtimeMs };
}

async function deletePost(rel) {
  const abs = resolvePost(rel);
  await fsp.unlink(abs).catch(() => { throw httpError(404, '文章不存在'); });
  const dir = path.dirname(abs);
  if (dir !== POSTS && !(await fsp.readdir(dir)).length) await fsp.rmdir(dir);
  return { ok: true };
}

async function upload(data) {
  const m = String(data.data || '').match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) throw httpError(400, '图片数据格式错误');
  const extByMime = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
  const ext = extByMime[m[1]];
  if (!ext) throw httpError(400, '只支持 png / jpg / gif / webp / svg');
  const d = new Date();
  const sub = `${d.getFullYear()}/${pad(d.getMonth() + 1)}`;
  const base = slugify(String(data.name || '').replace(/\.[^.]+$/, '')).slice(0, 40) || 'img';
  const name = `${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${base}${ext}`;
  const dir = path.join(UPLOADS, ...sub.split('/'));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), Buffer.from(m[2], 'base64'));
  return { url: `/assets/uploads/${sub}/${encodeURIComponent(name)}` };
}

async function gitStatus() {
  const [st, br] = await Promise.all([
    git(['status', '--porcelain=v1', '-uall']),
    git(['status', '-sb', '--porcelain=v1']),
  ]);
  if (!st.ok) throw httpError(500, st.stderr || 'git status 失败');
  const files = st.stdout.split('\n').filter(Boolean).map(l => {
    let p = l.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    return { code: l.slice(0, 2), path: p };
  });
  const branch = (br.stdout.split('\n')[0] || '').replace(/^## /, '');
  return { branch, files };
}

const CONTENT_PATHS = ['_posts', 'assets/uploads'];

async function publish(data) {
  const message = String(data.message || '').trim() || `更新博客 ${today()}`;
  const scope = data.all ? ['-A'] : ['-A', '--', ...CONTENT_PATHS];
  const log = [];
  const run = async argv => {
    const r = await git(argv);
    log.push('$ git ' + argv.join(' ') + '\n' + (r.stdout + r.stderr).trim());
    return r;
  };
  await run(['add', ...scope]);
  const staged = await git(['diff', '--cached', '--quiet']);
  if (!staged.ok) {
    const c = await run(['commit', '-m', message]);
    if (!c.ok) return { ok: false, log: log.join('\n\n') };
  } else {
    log.push('（没有需要提交的改动，直接推送）');
  }
  const p = await run(['push']);
  return { ok: p.ok, log: log.join('\n\n') };
}

async function pull() {
  const r = await git(['pull', '--ff-only']);
  return { ok: r.ok, log: ('$ git pull --ff-only\n' + r.stdout + r.stderr).trim() };
}

/* ---------------- Static ---------------- */

async function serveFile(res, base, rel) {
  const abs = path.resolve(base, '.' + rel);
  const r = path.relative(base, abs);
  if (r.startsWith('..') || path.isAbsolute(r) || r.split(path.sep).includes('.git')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  try {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) return serveFile(res, base, rel.replace(/\/?$/, '/index.html'));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(abs).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/* ---------------- Server ---------------- */

const server = http.createServer(async (req, res) => {
  // 防 DNS rebinding：只接受本机 Host
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { res.writeHead(403); return res.end('Forbidden'); }

  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }

  if (pathname.startsWith('/api/')) {
    // 自定义请求头会触发 CORS 预检，第三方网页无法跨站调用本地 API
    if (req.headers['x-blog-editor'] !== '1') return send(res, 403, { error: 'forbidden' });
    try {
      const q = url.searchParams;
      let result;
      switch (`${req.method} ${pathname}`) {
        case 'GET /api/posts': result = await listPosts(); break;
        case 'GET /api/post': result = await getPost(q.get('path')); {
          const st = await fsp.stat(resolvePost(q.get('path')));
          result.mtime = st.mtimeMs;
        } break;
        case 'POST /api/post': result = await savePost(await readBody(req)); break;
        case 'DELETE /api/post': result = await deletePost(q.get('path')); break;
        case 'POST /api/upload': result = await upload(await readBody(req)); break;
        case 'GET /api/git/status': result = await gitStatus(); break;
        case 'POST /api/git/publish': result = await publish(await readBody(req)); break;
        case 'POST /api/git/pull': result = await pull(); break;
        default: throw httpError(404, '未知接口');
      }
      return send(res, 200, result);
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    }
  }

  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (pathname === '/' || pathname === '/index.html') return serveFile(res, PUBLIC, '/index.html');
  if (pathname.startsWith('/editor/')) return serveFile(res, PUBLIC, pathname.slice('/editor'.length));
  // 其他路径映射到仓库根目录，供预览加载站点 CSS 和已上传图片
  return serveFile(res, REPO, pathname);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可能编辑器已经在运行：http://127.0.0.1:${PORT}/`);
    if (OPEN) openBrowser(`http://127.0.0.1:${PORT}/`);
  } else console.error(e);
  process.exit(1);
});

function openBrowser(u) {
  const cmd = process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
  exec(cmd, () => {});
}

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    const u = `http://127.0.0.1:${PORT}/`;
    console.log(`博客编辑器已启动：${u}`);
    console.log(`仓库目录：${REPO}`);
    console.log('按 Ctrl+C 退出');
    if (OPEN) openBrowser(u);
  });
}

module.exports = { parsePost, serializePost, slugify };
