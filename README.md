# dsh-profile-share

**English** | [简体中文](README.zh-CN.md)

> Share a DSH plugin setup as one pasteable code.

`dsh-profile-share` packages the plugins you selected in a DSH profile — their enabled state and
your explicit configuration — into a single short code. Another machine pastes that code and ends
up with the same setup; subsequent codes carry only what changed. The same page then reports which
API keys, environment variables and logins each machine still has to supply for itself, because
credentials never travel in the code.

## Features

- **Export** — pick plugins (all / none / invert), generate one `DSH-SHARE/1:` code. Suspected
  credential fields are stripped by default and every stripped path is listed.
- **Apply** — paste a code, preview the exact diff, then apply it. Only additions and updates by
  default; nothing is disabled or removed unless you turn on full alignment.
- **First-run configuration** — one page listing the credentials a machine still needs, with the
  secret fields writable there and login-only plugins linked to their own settings.

## Requirements

- A DSH profile that mounts the `pluginManager` and `configEditor` services (the desktop and web
  profiles of DSH 0.2.x do). Endpoints answer `503` with an explicit message when either is absent.
- Node.js `^22.19.0 || >=24.0.0` for the host half.
- The receiving machine needs this plugin installed too; a share code alone cannot bootstrap it.

## Installation

```sh
dsh plugin add https://github.com/sldmn233/dsh-profile-share
```

Or, from the plugin manager, install this checkout as a local directory. Restart DSH once after
installing. The page lives in **Settings → 分享与同步** (section id `profile-sync`).

## Usage

### 1. Export a code

Open **Settings → 分享与同步 → 分享**, tick the plugins you want to carry over, and press
**生成分享码**. The result is one line of text; copy it and send it however you like.

### 2. Apply a code

On the other machine open the **同步** tab, paste the code, press **预览**, and read the plan:
installations, enable/disable switches, and configuration writes. Press **应用** to run it.

### 3. Finish credentials

Open **首次配置**. Every detected requirement is listed as a secret, an environment variable, or a
login. Fill in your own values — the sender's keys were never in the code.

## Bootstrap on a machine that does not have the plugin

A share code cannot install its own reader, so a handoff starts with one message. The **分享**
tab's **复制引导语（含码）** button copies exactly this:

```
帮我安装这个 DSH 插件：https://github.com/sldmn233/dsh-profile-share
装好后用 profile_share_import 导入下面这条分享码，先给我看计划，我确认后再用 apply=true 执行：
DSH-SHARE/1:…
```

The receiving agent reads it, asks whether to install the plugin — that is the confirmation step —
installs it through the plugin manager, calls `profile_share_import` for a preview, applies it once
you agree, and then reports what is still missing, which is the same list the **首次配置** page
shows.

Why the message instead of full automation: nothing in a bare DSH can recognise a `DSH-SHARE/1:`
string before the plugin that understands it is installed. A prefix detector in DSH core would
remove the message entirely; until then this two-line prompt is the seam.

### Agent tools

| Tool | Purpose |
| --- | --- |
| `profile_share_import` | preview a share code, or apply it with `apply: true` |
| `profile_share_requirements` | list the credentials this profile still lacks |

## Share code format

The code is `gzip(JSON)` encoded as base64url behind a `DSH-SHARE/1:` prefix. The version suffix is
checked: a code from an incompatible format is rejected instead of being half-applied. The payload
holds the selected bundles (name, version, install spec, enabled state), the explicit profile
configuration of each row, and the sender's profile name and DSH version for the header.

## How it works

The host half (`index.js`) uses only public services, so the Loader keeps owning schema validation,
the profile file lock and hot reload:

| Service call | Purpose |
| --- | --- |
| `pluginManager.listBundles()` / `listPlugins()` | read the live inventory |
| `configEditor.configuration()` | read each row's explicit profile override |
| `configEditor.edit()` | write a row's configuration back through the profile patch |
| `installBundle()` / `setBundleEnabled()` / `setPluginEnabled()` | install and switch |

Six endpoints live under `/api/dsh-profile-sync/`: `state`, `export`, `preview`, `apply`,
`requirements`, `configure`. Writes require `application/json` and a same-origin request, and reuse
the host's own `connection.requestRejection` admission decision.

The client half (`client.js`) is a single `settings.section` page registered through
`ctx.slots.register`, requires only `react`, and has no build step.

## Security

- Suspected credentials (`apiKey`, `token`, `secret`, `password`, `cookie`, …) are removed on export
  by default, and the removed paths are reported. Enabling **包含可能的密钥字段** is an explicit,
  deliberate action.
- The code carries `apiKeyEnv`-style variable names, not the keys they name.
- Writes are same-origin only and go through the profile's own configuration editor, so every change
  is a normal, reviewable profile patch.

## Behavior notes

- Bundles provided by the DSH installation itself (`availability: 'installation'`) are never
  installed; they ship with DSH. Their configuration overrides are still shared, because that is
  what reproduces the setup.
- Bundles the sender has not installed are not shared and are reported as `stats.uninstalled`.
- Registry sources install as declared; `git+…` and `file:…` declarations pass through unchanged
  rather than being guessed at as `name@version`.
- Full alignment is off by default: nothing is disabled or removed unless you ask for it.

## Differences from similar plugins

[`wbb316/dsh-profile-sync`](https://github.com/wbb316/dsh-profile-sync) moves a plugin set between
two profiles on one machine and deliberately installs nothing. This plugin targets the machine-to-
machine, person-to-person case: the code is self-contained and the receiving DSH installs and
enables the delta itself. Both exist on purpose.

## Project layout

```
index.js            Host half: six endpoints, snapshot codec, plan/apply engine
client.js           Client half: the settings page (three tabs)
cordis.patch.yml    Bundle patch inserting the row
locale/             Localized plugin title and description
test/local-smoke.mjs  Offline harness driving the real handlers against mock services
```

## Development

No build step, no runtime dependencies.

```sh
npm run check              # syntax-check both halves
node test/local-smoke.mjs  # run the offline harness
```

The harness covers export and secret stripping, idempotent replay, install → enable → write on an
empty profile, requirement detection, `configure` path allow-listing, cross-origin rejection,
installation-provided bundles never being scheduled for install, row-level enable sync, and route
registration collisions during a hot reload.

## Contributing

Issues and pull requests are welcome: <https://github.com/sldmn233/dsh-profile-share/issues>.

## License

[MIT](LICENSE)
