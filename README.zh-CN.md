# dsh-profile-share

[English](README.md) | **简体中文**

> 把一套 DSH 插件配置打包成一条可粘贴的分享码。

`dsh-profile-share` 把你在 DSH profile 里勾选的插件——连同启用状态和显式配置——打包成一条很短的
分享码。另一台机器粘贴这条码就能得到同一套配置；之后新生成的码只携带变化的部分。同一个页面还会
列出各台机器**各自**仍需要补齐的 API Key、环境变量与登录态，因为凭据永远不会进入分享码。

## 功能

- **导出** —— 勾选插件（全选 / 全不选 / 反选），生成一条 `DSH-SHARE/1:` 分享码。疑似凭据字段默认
  被剥离，并逐条列出被剥离的路径。
- **应用** —— 粘贴分享码，先看精确差异，再执行。默认只新增和更新；不打开「完整对齐」就不会禁用或
  删除任何已有插件。
- **首次配置** —— 一页列出本机还缺的凭据：密钥项可直接在该页写入，需登录的插件则链接到它自己的
  设置页。

## 环境要求

- DSH profile 需挂载 `pluginManager` 与 `configEditor` 两个服务（DSH 0.2.x 的 desktop / web
  profile 默认满足）。缺任何一个时端点会返回 `503` 并说明原因。
- Host 半边要求 Node.js `^22.19.0 || >=24.0.0`。
- 接收方也需要安装本插件；单靠一条分享码无法自举。

## 安装

```sh
dsh plugin add https://github.com/sldmn233/dsh-profile-share
```

也可以在插件管理页用「本地目录」安装本仓库。装好后重启一次 DSH。入口在 **设置 → 分享与同步**
（section id 为 `profile-sync`）。

## 使用

### 1. 生成分享码

打开 **设置 → 分享与同步 → 分享**，勾选要带走的插件，点 **生成分享码**。结果是一行文本，复制后
随便用什么方式发给对方。

### 2. 应用分享码

在另一台机器上打开 **同步** 标签页，粘贴分享码，点 **预览**，阅读计划：哪些要安装、哪些要开关、
哪些要写配置。确认后点 **应用**。

### 3. 补齐凭据

打开 **首次配置**。检测到的每一项都会标注它是密钥、环境变量还是登录态。填**你自己的**值——
发送方的密钥从来没有进过分享码。

## 分享码格式

分享码是 `gzip(JSON)` 的 base64url 编码，前缀 `DSH-SHARE/1:`。版本号会被校验：格式不兼容的码会
直接报错，而不是应用一半。载荷包含所选 bundle（名称、版本、安装 spec、启用状态）、每个配置行的
显式覆盖层，以及发送方的 profile 名与 DSH 版本（供页头显示）。

## 实现方式

Host 半边（`index.js`）只调用公开服务，因此配置校验、profile 文件锁与热重载仍由 Loader 负责：

| 服务调用 | 用途 |
| --- | --- |
| `pluginManager.listBundles()` / `listPlugins()` | 读取实时清单 |
| `configEditor.configuration()` | 读取每个配置行的显式覆盖层 |
| `configEditor.edit()` | 通过 profile patch 写回配置 |
| `installBundle()` / `setBundleEnabled()` / `setPluginEnabled()` | 安装与开关 |

六个端点位于 `/api/dsh-profile-sync/`：`state`、`export`、`preview`、`apply`、`requirements`、
`configure`。写操作要求 `application/json` 且同源，并复用宿主自身的 `connection.requestRejection`
准入判定。

Client 半边（`client.js`）是一个通过 `ctx.slots.register` 注册的 `settings.section` 页面，只依赖
`react`，没有构建步骤。

## 安全说明

- 导出时默认移除疑似凭据字段（`apiKey`、`token`、`secret`、`password`、`cookie` 等），并列出被移除
  的路径。勾选「包含可能的密钥字段」是一个明确、主动的动作。
- 分享码携带的是 `apiKeyEnv` 这类**变量名**，不是它指向的密钥。
- 写操作仅限同源，并且走 profile 自己的配置编辑器，因此每次变更都是一条正常的、可审阅的 profile
  patch。

## 语义边界

- DSH 安装自带的内置 bundle（`availability: 'installation'`）永远不会被安装——它们随 DSH 分发。
  但它们的配置覆盖层仍会被分享，因为那才是复刻配置的关键。
- 发送方自己没有安装的 bundle 不会进分享码，会在 `stats.uninstalled` 里报出。
- 注册表来源按其声明安装；`git+…`、`file:…` 这类声明原样透传，不会被猜成 `name@version`。
- 「完整对齐」默认关闭：除非你明确要求，否则不会禁用或删除任何东西。

## 与相近插件的区别

[`wbb316/dsh-profile-sync`](https://github.com/wbb316/dsh-profile-sync) 是**同一台机器上**
两个 profile 之间搬运插件集，并且刻意不安装任何东西。本插件面向机器之间、人之间的场景：分享码自
包含，由接收方的 DSH 自己完成安装与启用。两者是有意共存的。

## 目录结构

```
index.js            Host 半边：六个端点、快照编解码、计划/应用引擎
client.js           Client 半边：设置页（三个标签页）
cordis.patch.yml    插入插件行的 bundle patch
locale/             插件标题与描述的本地化资源
test/local-smoke.mjs  用 mock 服务驱动真实 handler 的离线测试
```

## 开发

没有构建步骤，没有运行时依赖。

```sh
npm run check              # 两个半边的语法检查
node test/local-smoke.mjs  # 运行离线测试
```

测试覆盖：导出与密钥剥离、幂等回放、空 profile 上安装 → 启用 → 写配置、凭据需求检测、`configure`
路径白名单、跨源拒绝、内置 bundle 永不排入安装、行级启用状态同步，以及热重载时的路由注册撞名。

## 参与贡献

欢迎提 Issue 与 Pull Request：<https://github.com/sldmn233/dsh-profile-share/issues>。

## 许可证

[MIT](LICENSE)
