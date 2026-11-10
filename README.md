# Weibo Enhance (Flare 微博增强版插件)

Flare Social Plugin API v1 插件 —— 微博增强版，支持超话自动签到与多分组时间线。

## 功能特性

1. **自动超话签到**：
   - 打开或下拉刷新「最新微博Enhance」时间线时，自动扫描并签到关注的超话。
   - 签到通知卡片使用专属「超话签到」标识和当前用户的微博头像，隐去纯数字 UID。
2. **多标签页 / 分组支持**：
   - **最新微博Enhance**：主时间线，刷新时自动执行超话签到并展示签到摘要卡片，同时呈现最新关注博文。
   - **好友圈**：纯净好友圈动态流。
   - **特别关注**：单独浏览特别关注博主的动态。
   - 支持动态目录（Tab Catalog），可在 Flare 的标签页管理中随时添加或切换。
3. **平台与专属图标识别**：
   - 带有专属绿色打勾签到角标的微博图标，与 Flare 内置微博彻底区分。
   - 内置高优先级探测器（Detector，优先级 1000）：在 Flare 输入 `https://m.weibo.cn` 即可精准识别为 **Weibo Enhance**。

## 在 Flare 中安装

在 Flare 的插件管理中选择通过 GitHub 安装：

```text
https://github.com/PANGPANGDigital/Flare-App-Plugin
```

确认权限后安装。添加账号时在「输入服务器以开始」输入 `https://m.weibo.cn`（或 `m.weibo.cn`），系统会自动匹配出 **Weibo Enhance**，点击「登录」完成微博网页授权即可。

> **提示**：若已有账号想立刻看到新增的「好友圈」与「特别关注」标签页，可在时间线管理中点击添加，或重新登录账号，Flare 会自动创建对应的分组标签。

## 本地开发与构建

所有源码及配置文件已统一在根目录维护：

```sh
npm install
npm run check    # TypeScript 类型检查
npm run build    # 构建 plugin.js
```
