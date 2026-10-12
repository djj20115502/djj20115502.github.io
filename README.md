# Jupiter 的笔记

个人博客，托管在 GitHub Pages：<https://djj20115502.github.io/>

## 写文章（本地编辑器）

双击仓库根目录的 `editor.cmd`（或运行 `node tools/editor/server.js`），浏览器会自动打开 <http://127.0.0.1:4567/>。

- 左侧是文章列表，按分类分组，带 ● 的表示有改动还没发布
- 填写标题、分类、日期、标签、简介，正文用 Markdown，右侧实时预览（样式和线上一致）
- 图片直接 **粘贴** 或 **拖进** 编辑区，会保存到 `assets/uploads/年/月/`
- `Ctrl+S` 保存，`Ctrl+N` 新建；打开「草稿」开关后文章不会出现在网站上
- 点「发布」会把 `_posts` 和 `assets/uploads` 的改动 `git commit` 并 `git push`，GitHub Pages 约 1 分钟后更新
- 点「拉取」会执行 `git pull --ff-only`，在多台电脑之间同步

只需要 Node.js 18+，没有 npm 依赖；服务只监听本机。

## 目录结构

```
_posts/<分类>/YYYY-MM-DD-标题.md   文章，文件夹名就是分类
_layouts/ _includes/               页面模板
assets/css/main.css                站点样式（编辑器预览也用它）
assets/js/main.js                  目录、代码复制、搜索、深色模式
assets/uploads/                    文章图片
tools/editor/                      本地编辑器（不会被发布到网站）
```

## 文章头信息

```yaml
---
layout: post
title: 文章标题
date: 2026-10-12
intro: 一句话简介
tags: [Android, Gradle]
cover: /assets/uploads/2026/10/cover.png   # 可选
published: false                            # 可选，草稿
---
```
