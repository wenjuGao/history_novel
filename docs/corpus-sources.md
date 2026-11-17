# 古籍来源与许可

## 当前来源

默认目录暂用维基文库普通书目页与卷页：

- 站点许可：CC BY-SA 4.0，复用文本须署名并按相同方式共享。
- 逐页记录页面 URL、固定 oldid、获取时间、Wikisource 贡献者归属和识别到的页面许可模板；页面有 `PD-old` 标记时同时保存该标记，不将站点默认许可误说成所有页面的公版证明。
- Robots 复核于 2026-10-28：通用 `/w/`、`/api/` 被禁止，故采集器只访问普通 `/wiki/<title>` 页面及其书目/卷链接，不调用 Action API、Special 页面或下载端点。
- 站点条款：[Wikimedia Terms of Use](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use)；[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)；[robots.txt](https://zh.wikisource.org/robots.txt)。

## 已验证结构

- Wikisource 的二十四史分类页列出 24 部正史，路径为 `https://zh.wikisource.org/wiki/Category:%E4%BA%8C%E5%8D%81%E5%9B%9B%E5%8F%B2`。
- 普通主页抽样：`史記` 链接到 130 卷，`資治通鑑` 链接到 294 卷；主页和样例卷可访问，卷目计数需随每次采集重新验证。
- 书目页示例：`https://zh.wikisource.org/wiki/史記`、`https://zh.wikisource.org/wiki/資治通鑑`。示例卷页：`https://zh.wikisource.org/wiki/史記/卷001`。
- `史記` 页的版本固定链接显示 `oldid=8732448`；`資治通鑑` 页显示 `oldid=5978127`。采集记录保存实际页面版本，不将这些示例 oldid 当作全书固定版本。

## 合规抓取要求

逐请求串行、至少间隔 1.2 秒；使用明确 User-Agent，遵守 Retry-After，对 429/5xx 有界重试。只保留获取原文所需的页面与来源信息，不抓取现代点校本、白话译文、付费/登录墙内容；不得绕过验证码或 robots 限制。文本及其元数据随项目备份，保留 CC BY-SA 来源署名，导出再利用时附许可证与出处。

抓取成功仅说明页面被下载，不代表转录无错或史实已核定。每书按实际卷目清单验完整率；卷数不匹配、正文为空或异常短的页标记为待核查，不能显示为完整。