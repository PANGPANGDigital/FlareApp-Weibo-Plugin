# Flare-App-Plugin (Weibo Enhance)

Flare Social Plugin API v1 插件 —— 微博增强版。

## Weibo Enhance 微博增强版

插件提供独立的「最新微博Enhance」时间线。刷新时自动检查已关注超话，对尚未签到的项目自动提交签到，并在时间线顶部生成签到结果卡片，同时加载关注的好友微博。它使用独立插件账号，并带有专属角标图标，与 Flare 内置微博完全区分。详见 [Weibo.Plugin 文档](Weibo.Plugin/README.md)。

### 在 Flare 中安装

在 Flare 的插件管理中通过 GitHub 添加此仓库：

```text
https://github.com/PANGPANGDigital/Flare-App-Plugin
```

检查插件来源和媒体权限后确认安装。插件自带高优先级服务探测器（Detector）：在 Flare「输入服务器以开始」输入 `https://m.weibo.cn`（或 `m.weibo.cn`），Flare 会自动匹配到带专属角标的 **`Weibo Enhance`** 平台卡片，点击登录即可通过微博网页登录。打开它的「最新微博Enhance」时间线并刷新即可触发签到检查和加载最新博文。

### 仓库布局

`Weibo.Plugin/` 保留 TypeScript 源码和开发配置。Flare 安装器读取仓库根目录的 `manifest.json`、`plugin.js` 和 `assets/icon.png`；这些安装文件由子项目生成并同步到根目录。

在 `Weibo.Plugin/` 目录运行 `npm run publish:root`，会构建插件并更新根目录安装文件。发布时保持根目录和子项目的 manifest 版本一致，并创建匹配版本的稳定 tag（例如 `0.2.3` 或 `v0.2.3`）。
