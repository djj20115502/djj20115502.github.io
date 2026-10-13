# IPv6 地址上报（GitHub Pages 版）

不用自建服务器：本机脚本检测到公网 IPv6 变化后，把数据**加密**写进 `ipv6/data.json` 并 git 推送，
GitHub Pages 自动发布。打开 <https://djj20115502.github.io/ipv6/>，输入密码后在浏览器本地解密查看。

```
Windows 计划任务（每 5 分钟）
  report-ipv6.ps1 采集公网 IPv6
    └─ 与上次结果相同 → 结束（不联网）
    └─ 变化了 → fetch → 解密远端 data.json → 更新本机记录 → 重新加密 → 生成提交 → push
                                              └─▶ GitHub Pages → ipv6/index.html 输入密码 → 本地解密展示
```

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` | 展示页，读取 `data.json` 渲染，60 秒自动刷新 |
| `data.json` | 加密后的上报数据，由脚本维护，不要手改 |
| `report-ipv6.ps1` | 检测并上报 |
| `report-ipv6.bat` | 双击入口：首次运行自动安装，之后手动上报一次 |
| `install-task.ps1` / `uninstall-task.ps1` | 注册 / 卸载计划任务 |
| `config.example.json` | 配置模板；`config.json`（含密码，不入库）由 install-task.ps1 首次运行时生成 |

## 安装

前提：这台机器已经能 `git push` 这个仓库（SSH 密钥不能带口令，后台任务没法输入）。

**双击 `report-ipv6.bat`** 就行：

- 首次运行：弹出 UAC 确认 → 设置加密密码（写入本目录 `config.json`，不入库）→ 注册计划任务 → 立即上报一次。
  之后**每次开机自动运行**，并且每 5 分钟检测一次。
- 已安装后再双击：手动上报一次（不用等下一个 5 分钟）。
- 挪了仓库位置或想改间隔：`report-ipv6.bat --install` 重新安装，
  或管理员 PowerShell 里 `.\install-task.ps1 -IntervalMinutes 10`。

任务以当前用户身份（S4U）运行：不弹窗、不需要登录，能用到你的 git 配置和 SSH 密钥。
脚本记录的是本目录的路径，装好后别挪动仓库。

## 细节

- **不碰你的工作区**：直接用本仓库，但提交是用 git 底层命令（临时 index + `commit-tree`）
  基于 `origin/master` 生成的，只改 `ipv6/data.json`，然后直接推到远端。
  工作区、暂存区、HEAD、本地分支都不动，你没提交的改动、没推送的提交（比如写了一半的文章）不会被带上去。
  代价是本地 master 会落后，写博客前先 `git pull`（会是快进）。
- **只在变化时提交**：比对主 IPv6、内网 IPv4、主机名、备注；临时 IPv6 地址每天轮换，不参与比对。
  每 24 小时还会跟远端核对一次（防止记录被误删）。
- **多台机器**：每台机器按 MachineGuid 的哈希区分，各写各的一条；推送冲突会自动重新同步重试。
- 日志：`%LOCALAPPDATA%\ipv6-reporter\report.log`

## 配置（可选）

`config.json`：

| 字段 | 说明 |
|---|---|
| `host_name` | 页面上显示的名字，留空用计算机名 |
| `note` | 备注，会显示在页面上 |
| `branch` | 推送分支，默认 `master` |
| `password` | 加密密码（必填），多台机器必须一致 |

## 附带访问链接（可选）

别的程序可以把访问链接登记到 `%LOCALAPPDATA%\ipv6-reporter\links.json`，脚本会把它们并进本机那条记录、**一起加密**上报，
页面上每台主机下面显示「访问链接」（可点、可复制，只显示 `http(s)://`）。

```json
{"links": [{"source": "webremote", "label": "网页遥控 IPv6", "url": "http://[2409:...]:27186/?t=..."}]}
```

- 按 `source` 区分来源，各程序只改自己那几条。文件放在仓库外：链接里可能带 token，绝不能进仓库明文。
- 链接参与变化比对：链接变了也会提交；文件不存在或格式坏了就不带链接，地址照常上报。
- 目前的登记方：AI_GAME 网页遥控（`webremote/publish.py`）——开启时和地址变化时写入并立即调用一次本脚本。

## 加密

- 算法：PBKDF2-SHA256（20 万次）派生密钥 → AES-256-CBC 加密 → HMAC-SHA256 校验（encrypt-then-MAC）。
  浏览器端用 WebCrypto 解密，密码不离开浏览器。
- 仓库里能看到的只有密文、提交时间和提交信息（固定为 `ipv6: update`，不含主机名和地址）。
- **密码只存在各台机器的 `config.json` 里，不要放进仓库**——无论明文还是编译进二进制，
  公开仓库里的东西都可以被拿去逆向，等于没加密。
- 安全性取决于密码强度：密文是公开的，别人可以离线暴力破解，建议 12 位以上随机密码。
- 换密码：所有机器的 `config.json` 一起改，然后任意一台运行 `report-ipv6.ps1 -Force`。
  注意旧密码加密的数据会解不开，需先删掉远端 `data.json` 里的密文（改回 `{"updated_at":"","hosts":[]}`）再上报。
- 网页上勾选「记住密码」会把密码明文存在该浏览器的 localStorage 里，只在自己的设备上勾。
