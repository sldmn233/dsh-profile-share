# DSH Profile Sync · 分享与同步

Turn your DSH plugin setup into **one pasteable line**. Someone else pastes it and gets your
plugins, their enabled state, and your explicit configuration; later lines carry only the delta.
The same page then tells each machine which API keys, environment variables and logins it still
has to supply for itself.

一个 DSH 插件，把当前 profile 的插件选择、启用状态与显式配置打包成**一条可粘贴的分享码**；
别人粘贴即可复刻同一套 DSH，之后发新码只同步差异，并在同一页里补齐各自机器缺的凭据。

> 你的 dsh 很好，现在它是我的了。

## Install · 安装

```sh
dsh plugin add https://github.com/sldmn233/dsh-profile-share
```

Or install the checkout as a local directory from the plugin manager. Restart DSH once after
installing; the page lives at **Settings → 分享与同步** (id `profile-sync`, order 45).

装好后重启一次 DSH，入口在 **设置 → 分享与同步**；也可以用插件页的「本地目录」安装本仓库。

## What it does · 功能

| 能力 | 行为 |
| --- | --- |
| 分享 | 勾选插件（全选/反选）→ 生成 `DSH-SHARE/1:` 分享码；默认剥离疑似密钥字段并列出被剥离的路径 |
| 同步 | 粘贴码 → 预览差异 → 应用。默认只新增/更新；勾「完整对齐」才会禁用对方已有、但码里没有的 profile 插件 |
| 首次配置 | 逐项列出缺的 API Key、环境变量与需手动完成的登录态；密钥项可直接在该页写入 |

## How a handoff works · 怎么给对方

1. Install this plugin once (the repo URL above), then share codes freely.
2. Paste the code in **同步**, preview the diff, apply.
3. Open **首次配置** and fill in your own keys — the sender's secrets are never in the code.

## Not the same as a profile-to-profile mover · 与「profile 之间搬运」的区别

[`wbb316/dsh-profile-sync`](https://github.com/wbb316/dsh-profile-sync) moves a plugin set
between two profiles on one machine and deliberately installs nothing. This plugin is for the
cross-machine, cross-person case: the code is self-contained, the receiving DSH installs and
enables the delta itself through the host's plugin manager, and it never needs the sender's
machine. Both exist on purpose.

## How it works · 实现

The Host half (`index.js`) only uses public services, so the Loader keeps owning validation,
the profile file lock and hot reload:

- `pluginManager.listBundles()` / `listPlugins()` — live inventory;
- `configEditor.configuration()` — each row's explicit profile override; writes go through
  `configEditor.edit()`;
- `installBundle()` / `setBundleEnabled()` / `setPluginEnabled()` — installation and switches.

The share code is `gzip(JSON)` as base64url with a `DSH-SHARE/1:` prefix; a mismatched version
fails loudly instead of half-applying. Six endpoints under `/api/dsh-profile-sync/`:
`state`, `export`, `preview`, `apply`, `requirements`, `configure`. Writes require
`application/json` and a same-origin request, and reuse the host's `connection.requestRejection`
admission decision.

The Client half (`client.js`) is one `settings.section` page, `require('react')` only, no build
step.

## Boundaries · 语义边界

- Bundles provided by the DSH installation (`availability: 'installation'`) are never installed —
  they ship with DSH — but their configuration overrides are still shared, because that is what
  reproduces your setup (default model, theme size, providers).
- Bundles the sender has not installed are not shared; `stats.uninstalled` reports them.
- Registry sources install as declared (`name@version`); `git+…` / `file:…` declarations pass
  through unchanged rather than being guessed.
- **完整对齐** is off by default: nothing is disabled or removed unless you ask for it.
- Secrets are stripped on export by default; opt in only when you really mean to move a key.

## Files · 目录

```
index.js           Host half: six endpoints, snapshot codec, plan/apply engine
client.js          Client half: the settings page (three tabs)
cordis.patch.yml   bundle patch inserting the row
locale/            localized plugin title and description
test/              offline harness (mock services) + real share-code fixtures
```

## Self-test · 自测

```sh
npm run check                     # syntax
node test/local-smoke.mjs         # drives the real handlers against mock services
```

The harness covers export/secret stripping, idempotent replay, install→enable→write on an empty
profile, requirement detection, `configure` path allow-listing, cross-origin rejection, shipped
bundles never scheduled for install, row-level enable sync, reload route collisions, and both
directions of a real share code (replay your own, and an empty receiver).

## Known limits · 已知取舍

- The settings navigation icon is chosen by the shell from the section id, so this page shows the
  generic gear regardless of its `icon` option.
- Login-only plugins cannot be completed from this page; it links them to their own settings.
- Host-side edits need a restart when the row is already in a failed state; `client.js` changes
  only need a page refresh.

## License

MIT
