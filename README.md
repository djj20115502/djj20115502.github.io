# jekyll模板说明
## 文件存放位置
在文件夹 **_posts** 中放置博客。 [参见博客](http://alfred-sun.github.io/blog/2015/01/10/jekyll-liquid-syntax-documentation/)
> 对于博客 post，文件命名规则必须是 YEAR-MONTH-DAY-title.MARKUP 的格式。
使用 rake post 会自动将 post 文件合适命名。
例如

```
2014-11-06-memcached-lib.md
```

## md头文件
```
---
title: 333
layout: blog
icon: /assets/images/pic02.jpg
intro: 简介
---
```
1. title 文章的标题，必填
2. layout 属于博客性质的都用blog，必填
3. intro  文章简介，可缺省
4. icon: 图标，，可缺省