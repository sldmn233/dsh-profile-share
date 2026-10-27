/**
 * Offline harness for the Host half: drives the real HTTP handlers against mock
 * `pluginManager` / `configEditor` services, so plan/apply logic is proven before
 * the bundle is installed into a live profile.
 *
 * Run with: node test/local-smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { apply } from '../index.js'

const PREFIX = 'DSH-SHARE/1:'

/** Decode a share code the same way the Host does, for structural assertions. */
function decode(code) {
  return JSON.parse(gunzipSync(Buffer.from(code.trim().slice(PREFIX.length), 'base64url')).toString('utf8'))
}

function encode(payload) {
  return PREFIX + gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url')
}

/**
 * A share code captured from a real profile. It lists that machine's plugins and
 * configuration, so it stays a local fixture and is not published with the repo;
 * the two scenarios that use it skip when it is absent.
 */
const SAMPLE_PATH = join(import.meta.dirname, 'sample-code.txt')

function sampleCode() {
  return existsSync(SAMPLE_PATH) ? readFileSync(SAMPLE_PATH, 'utf8').trim() : null
}

// ---------------------------------------------------------------------------
// Mock profile
// ---------------------------------------------------------------------------

function createProfile() {
  const state = {
    bundles: [
      {
        name: 'alpha',
        version: '1.0.0',
        official: false,
        availability: 'profile',
        installed: true,
        enabled: true,
        removable: true,
        optional: false,
        installTarget: { spec: 'alpha@1.0.0', version: '1.0.0' },
        meta: { title: { zh: '阿尔法', en: 'Alpha' }, description: 'demo' },
        rows: [{ rowId: 'alpha' }],
      },
      {
        name: 'beta',
        version: '0.2.1',
        official: true,
        availability: 'installation',
        installed: false,
        enabled: true,
        removable: false,
        optional: false,
        rows: [{ rowId: 'beta' }],
      },
      {
        name: 'gamma',
        version: '2.0.0',
        official: false,
        availability: 'profile',
        installed: true,
        enabled: false,
        removable: true,
        optional: false,
        rows: [{ rowId: 'gamma' }],
      },
    ],
    rows: new Map(),
    installed: new Set(['alpha', 'beta', 'gamma']),
    enabledRows: new Map([['alpha', true], ['beta', true], ['gamma', false]]),
    edits: [],
    toggles: [],
    installs: [],
  }
  state.rows.set('alpha', {
    entry: {
      options: {
        id: 'alpha',
        name: 'alpha',
        config: { apiKey: '', model: 'x', maxTokens: 10, apiKeyEnv: 'ALPHA_API_KEY' },
      },
    },
    inherited: { model: 'default', maxTokens: 10 },
    override: { apiKey: '', model: 'x', apiKeyEnv: 'ALPHA_API_KEY' },
  })
  state.rows.set('beta', {
    entry: { options: { id: 'beta', name: 'beta', config: { nested: { token: 'sk-live-value', retries: 3 } } } },
    inherited: { nested: { retries: 3 } },
    override: { nested: { token: 'sk-live-value', retries: 3 } },
  })
  state.rows.set('gamma', {
    entry: { options: { id: 'gamma', name: 'gamma', config: { mode: 'fast' } } },
    inherited: {},
    override: { mode: 'fast' },
  })
  return state
}

function createCtx(profile, options = {}) {
  const routes = new Map()
  const registeredTools = new Map()
  const manager = {
    async listBundles() {
      return profile.bundles
        .filter((bundle) => bundle.availability !== 'profile' || profile.installed.has(bundle.name))
        .map((bundle) => ({
          ...bundle,
          rows: bundle.rows.filter((row) => profile.rows.has(row.rowId)),
          overrides: undefined,
        }))
    },
    async listPlugins() {
      return [...profile.rows.values()].map((row) => ({
        entryId: row.entry.options.id,
        patchId: row.entry.options.id,
        moduleName: row.entry.options.name,
        enabled: profile.enabledRows.get(row.entry.options.id) ?? true,
        fiberPhase: 'active',
      }))
    },
    async installBundle(spec) {
      profile.installs.push(spec)
      const name = spec.split('@')[0]
      profile.installed.add(name)
      const bundle = profile.bundles.find((candidate) => candidate.name === name)
      for (const row of bundle?.rows ?? []) {
        const restore = profile.defaultRows?.get(row.rowId)
        if (restore !== undefined && !profile.rows.has(row.rowId)) profile.rows.set(row.rowId, restore)
      }
      return { changed: true, application: 'applied', stage: 'install', target: spec }
    },
    async setBundleEnabled(name, enabled) {
      profile.toggles.push([name, enabled])
      const bundle = profile.bundles.find((candidate) => candidate.name === name)
      if (bundle !== undefined) bundle.enabled = enabled
      return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
    },
    async setPluginEnabled(id, enabled) {
      profile.toggles.push([id, enabled])
      return { changed: true, application: 'applied', stage: 'enable', target: id, enabled }
    },
  }
  const editor = {
    configuration() {
      return [...profile.rows.values()].map(({ entry, inherited, override }) => ({
        entry,
        inherited,
        override,
      }))
    },
    entries() {
      return [...profile.rows.values()].map((row) => row.entry)
    },
    async edit(entry, change) {
      const row = [...profile.rows.values()].find((candidate) => candidate.entry === entry)
      const next = change(row.entry.options.config, row.inherited)
      profile.edits.push({ id: row.entry.options.id, next })
      row.entry.options.config = next
      row.override = next
      return undefined
    },
  }
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    inject(_dependencies, callback) {
      const tools = {
        register(definition) {
          registeredTools.set(definition.name, definition)
          return () => registeredTools.delete(definition.name)
        },
      }
      const toolsCtx = {
        tools,
        effect(callback, _label) {
          const iterator = callback()
          if (iterator !== undefined && typeof iterator.next === 'function') {
            let step = iterator.next()
            while (step.done !== true) step = iterator.next(step.value)
          }
          return () => {}
        },
      }
      callback(toolsCtx)
      return () => {}
    },
    get(name) {
      if (name === 'pluginManager') return manager
      if (name === 'configEditor') return editor
      if (name === 'profileContext') return options.profileContext
      return undefined
    },
  }
  apply(ctx)
  routes.tools = registeredTools
  return routes
}

function makeRequest({ method = 'GET', body, headers = {} }) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    headers: {
      host: '127.0.0.1:1234',
      'content-type': body === undefined ? undefined : 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
}

function makeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
    },
  }
}

async function call(routes, path, options = {}) {
  const route = routes.get(`/api/dsh-profile-sync/${path}`)
  assert.ok(route !== undefined, `route ${path} registered`)
  const response = makeResponse()
  await route.handler(makeRequest(options), response)
  return { status: response.status, json: response.body === '' ? null : JSON.parse(response.body) }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const log = (label) => console.log(`\n=== ${label} ===`)

log('state')
{
  const profile = createProfile()
  const routes = createCtx(profile)
  const { status, json } = await call(routes, 'state')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.bundles.length, 3)
  assert.equal(json.bundles[0].title, '阿尔法', 'localized title resolved')
  assert.equal(json.bundles[2].enabled, false)
  assert.equal(json.counts.rows, 3)
  console.log('ok:', json.counts)
}

log('export strips secrets by default')
{
  const profile = createProfile()
  const routes = createCtx(profile)
  const { status, json } = await call(routes, 'export', {
    method: 'POST',
    body: { bundles: ['alpha', 'beta'] },
  })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.match(json.code, /^DSH-SHARE\/1:/)
  assert.ok(json.stats.stripped.includes('alpha.apiKey'), `stripped alpha.apiKey: ${json.stats.stripped}`)
  assert.ok(json.stats.stripped.includes('beta.nested.token'), `stripped beta.nested.token: ${json.stats.stripped}`)
  assert.ok(!JSON.stringify(json).includes('sk-live-value'), 'secret value never leaves the machine')
  console.log('ok: stripped', json.stats.stripped, 'bytes', json.stats.bytes)

  const withSecrets = await call(routes, 'export', {
    method: 'POST',
    body: { bundles: ['beta'], includeSecrets: true },
  })
  assert.equal(withSecrets.json.stats.stripped.length, 0)
  console.log('ok: includeSecrets keeps values')
}

log('preview is satisfied for an identical profile')
{
  const profile = createProfile()
  const routes = createCtx(profile)
  const exported = await call(routes, 'export', { method: 'POST', body: { bundles: ['alpha', 'beta', 'gamma'], includeSecrets: true } })
  const preview = await call(routes, 'preview', { method: 'POST', body: { code: exported.json.code } })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.steps.filter((step) => step.status === 'pending').length, 0, JSON.stringify(preview.json.steps))
  assert.equal(preview.json.manifest.bundles.length, 3)
  console.log('ok: 0 pending steps')
}

log('apply on an empty peer installs, enables, and writes config')
{
  const sender = createProfile()
  const senderRoutes = createCtx(sender)
  const exported = await call(senderRoutes, 'export', {
    method: 'POST',
    body: { bundles: ['alpha', 'gamma'], includeSecrets: true },
  })

  const peer = createProfile()
  peer.installed = new Set()
  peer.defaultRows = new Map(peer.rows)
  peer.rows = new Map()
  peer.bundles = peer.bundles.map((bundle) => ({ ...bundle }))
  // The peer re-installs the bundle with its own drifted configuration, so the
  // share code must overwrite that value rather than report "satisfied".
  peer.defaultRows.get('alpha').entry.options.config.model = 'peer-model'
  const peerRoutes = createCtx(peer)

  const preview = await call(peerRoutes, 'preview', { method: 'POST', body: { code: exported.json.code } })
  const pending = preview.json.steps.filter((step) => step.status === 'pending')
  assert.ok(pending.some((step) => step.kind === 'install'), 'plans installs')
  console.log('ok: preview pending', pending.length)

  // Installs in the mock restore the row declarations, so config steps follow.
  const originalInstall = peer.installs
  const applied = await call(peerRoutes, 'apply', { method: 'POST', body: { code: exported.json.code } })
  assert.equal(applied.status, 200)
  assert.equal(applied.json.ok, true)
  assert.ok(originalInstall.length >= 2, `installBundle called: ${JSON.stringify(originalInstall)}`)
  assert.ok(applied.json.changed >= 2, `changed count: ${applied.json.changed}`)
  assert.ok(peer.edits.length >= 1, 'config written on the peer')
  console.log('ok: changed', applied.json.changed, 'edits', peer.edits.map((edit) => edit.id))
}

log('requirements reports missing secrets and environment variables')
{
  const profile = createProfile()
  const routes = createCtx(profile)
  delete process.env.ALPHA_API_KEY
  const { json } = await call(routes, 'requirements')
  assert.equal(json.ok, true)
  const envItem = json.items.find((item) => item.kind === 'env' && item.envName === 'ALPHA_API_KEY')
  assert.ok(envItem !== undefined, 'env requirement detected')
  assert.equal(envItem.status, 'missing')
  const secretItem = json.items.find((item) => item.kind === 'secret' && item.path === 'apiKey')
  assert.ok(secretItem !== undefined, `secret requirement detected: ${JSON.stringify(json.items)}`)
  assert.equal(secretItem.status, 'missing')
  const readySecret = json.items.find((item) => item.kind === 'secret' && item.path === 'nested.token')
  assert.ok(readySecret !== undefined && readySecret.status === 'ready', 'populated secret is ready')
  console.log('ok: items', json.items.map((item) => `${item.kind}:${item.path}:${item.status}`))

  process.env.ALPHA_API_KEY = 'present'
  const after = await call(routes, 'requirements')
  assert.equal(after.json.items.find((item) => item.kind === 'env' && item.envName === 'ALPHA_API_KEY').status, 'ready')
  delete process.env.ALPHA_API_KEY
  console.log('ok: env presence reflected')
}

log('configure writes only a detected secret path')
{
  const profile = createProfile()
  const routes = createCtx(profile)
  const ok = await call(routes, 'configure', {
    method: 'POST',
    body: { entryId: 'alpha', path: 'apiKey', value: 'sk-new' },
  })
  assert.equal(ok.status, 200)
  assert.equal(profile.edits.length, 1)
  assert.equal(profile.edits[0].next.apiKey, 'sk-new')
  console.log('ok: wrote', profile.edits[0].next)

  const rejected = await call(routes, 'configure', {
    method: 'POST',
    body: { entryId: 'alpha', path: 'model', value: 'evil' },
  })
  assert.equal(rejected.status, 400)
  console.log('ok: rejected non-credential path')
}

log('mutation guard rejects cross-origin and non-JSON writes')
{
  const profile = createProfile()
  const routes = createCtx(profile)
  const crossOrigin = await call(routes, 'export', {
    method: 'POST',
    body: { bundles: ['alpha'] },
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(crossOrigin.status, 403)
  const wrongType = await call(routes, 'export', {
    method: 'POST',
    body: { bundles: ['alpha'] },
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongType.status, 415)
  console.log('ok: 403 cross-origin, 415 wrong content type')
}

log('bad share codes fail loudly')
{
  const profile = createProfile()
  const routes = createCtx(profile)
  const missingPrefix = await call(routes, 'preview', { method: 'POST', body: { code: 'nope' } })
  assert.equal(missingPrefix.status, 400)
  const truncated = await call(routes, 'preview', { method: 'POST', body: { code: 'DSH-SHARE/1:AAAA' } })
  assert.equal(truncated.status, 400)
  const empty = await call(routes, 'preview', { method: 'POST', body: { code: '   ' } })
  assert.equal(empty.status, 400)
  console.log('ok: 400 for malformed codes')
}

log('profile identity, declared specs, and shipped bundles')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-test-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    dependencies: { alpha: 'git+https://example.invalid/alpha.git' },
  }))
  const anchor = join(dir, 'install')
  mkdirSync(anchor)
  writeFileSync(join(anchor, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }))

  const profile = createProfile()
  const routes = createCtx(profile, { profileContext: { dir, installAnchor: anchor } })
  const state = await call(routes, 'state')
  assert.equal(state.json.profile.name, basename(dir), 'profile name comes from profileContext.dir')
  assert.equal(state.json.profile.dshVersion, '9.9.9-test', 'dsh version comes from the install anchor')
  const exported = await call(routes, 'export', { method: 'POST', body: { bundles: ['alpha', 'beta'] } })
  const payload = decode(exported.json.code)
  assert.equal(payload.source.profile, basename(dir))
  assert.equal(payload.bundles.find((bundle) => bundle.name === 'alpha').spec, 'git+https://example.invalid/alpha.git')
  assert.equal(payload.bundles.find((bundle) => bundle.name === 'beta').shipped, true)
  console.log('ok: identity', state.json.profile.name, '/', state.json.profile.dshVersion, '| git spec preserved | shipped flagged')
  rmSync(dir, { recursive: true, force: true })
}

log('a shipped bundle is never planned for installation')
{
  const profile = createProfile()
  const routes = createCtx(profile)
  const exported = await call(routes, 'export', { method: 'POST', body: { bundles: ['beta'] } })
  const preview = await call(routes, 'preview', { method: 'POST', body: { code: exported.json.code } })
  const installs = preview.json.steps.filter((step) => step.kind === 'install')
  assert.deepEqual(installs, [], 'installation-provided bundle schedules no install')
  assert.ok(preview.json.steps.some((step) => step.kind === 'skip' && step.detail.includes('随 DSH 安装')))
  console.log('ok: no install step for availability=installation')
}

log('replaying a real share code against a full profile schedules no installs')
if (sampleCode() === null) console.log('skipped: test/sample-code.txt is a local-only fixture')
else {
  const code = sampleCode()
  const shared = decode(code)
  const profile = createProfile()
  profile.bundles = shared.bundles.map((bundle) => ({
    name: bundle.name,
    version: bundle.version ?? '0.0.0',
    official: bundle.name.startsWith('@deepseek-ai/'),
    availability: bundle.name.startsWith('@deepseek-ai/dsh-') ? 'installation' : 'profile',
    installed: !bundle.name.startsWith('@deepseek-ai/dsh-'),
    enabled: bundle.enabled,
    removable: true,
    optional: false,
    rows: [],
  }))
  profile.installed = new Set(profile.bundles.filter((bundle) => bundle.installed).map((bundle) => bundle.name))
  const routes = createCtx(profile)
  const preview = await call(routes, 'preview', { method: 'POST', body: { code } })
  assert.equal(preview.status, 200, JSON.stringify(preview.json))
  const installs = preview.json.steps.filter((step) => step.kind === 'install')
  assert.deepEqual(installs, [], `no installs expected: ${JSON.stringify(installs.map((step) => step.target))}`)
  console.log('ok: real code', shared.bundles.length, 'bundles → 0 installs; shipped skips:',
    preview.json.steps.filter((step) => step.detail.includes('随 DSH 安装')).length)
}

log('a shipped bundle stays out of the plan even on a machine that lacks it')
if (sampleCode() === null) console.log('skipped: test/sample-code.txt is a local-only fixture')
else {
  const code = sampleCode()
  const shared = decode(code)
  shared.bundles = shared.bundles.map((bundle) => ({ ...bundle, shipped: bundle.name.startsWith('@deepseek-ai/dsh-') }))
  const reissued = encode(shared)
  const profile = createProfile()
  const routes = createCtx(profile)
  const preview = await call(routes, 'preview', { method: 'POST', body: { code: reissued } })
  const shippedInstalls = preview.json.steps
    .filter((step) => step.kind === 'install')
    .filter((step) => step.target.startsWith('@deepseek-ai/dsh-'))
  assert.deepEqual(shippedInstalls, [], 'shipped flag alone prevents an install')
  console.log('ok: shipped flag honoured without a local installation entry')
}

log('an uninstalled profile bundle is not shared')
{
  const profile = createProfile()
  profile.bundles.push({
    name: 'omega',
    version: null,
    official: false,
    availability: 'missing',
    installed: false,
    enabled: true,
    removable: true,
    optional: false,
    rows: [],
  })
  profile.installed.delete('omega')
  const routes = createCtx(profile)
  const exported = await call(routes, 'export', { method: 'POST', body: { bundles: ['alpha', 'omega'] } })
  assert.equal(exported.status, 200)
  assert.deepEqual(exported.json.stats.uninstalled, ['omega'])
  assert.equal(decode(exported.json.code).bundles.length, 1, 'only the installed bundle is shared')
  const onlyUninstalled = await call(routes, 'export', { method: 'POST', body: { bundles: ['omega'] } })
  assert.equal(onlyUninstalled.status, 400)
  console.log('ok: uninstalled bundle skipped and reported')
}

log('a row-level enable switch is shared and applied')
{
  const sender = createProfile()
  sender.enabledRows.set('alpha', false)
  const senderRoutes = createCtx(sender)
  const exported = await call(senderRoutes, 'export', { method: 'POST', body: { bundles: ['alpha'] } })
  assert.equal(decode(exported.json.code).bundles[0].rows[0].enabled, false, 'disabled row is exported as disabled')

  const peer = createProfile()
  peer.enabledRows.set('alpha', true)
  const peerRoutes = createCtx(peer)
  const preview = await call(peerRoutes, 'preview', { method: 'POST', body: { code: exported.json.code } })
  const toggle = preview.json.steps.find((step) => step.kind === 'disable' && step.target === 'alpha')
  assert.ok(toggle !== undefined, `row toggle planned: ${JSON.stringify(preview.json.steps)}`)

  const applied = await call(peerRoutes, 'apply', { method: 'POST', body: { code: exported.json.code } })
  assert.equal(applied.status, 200)
  assert.ok(peer.toggles.some(([id, enabled]) => id === 'alpha' && enabled === false), `setPluginEnabled called: ${JSON.stringify(peer.toggles)}`)
  console.log('ok: row disable planned and applied via setPluginEnabled')
}

log('a receiver without the plugins installs exactly the profile bundles')
if (sampleCode() === null) console.log('skipped: test/sample-code.txt is a local-only fixture')
else {
  const code = sampleCode()
  const shared = decode(code)
  const profile = createProfile()
  for (const bundle of shared.bundles) {
    if (!bundle.name.startsWith('@deepseek-ai/dsh-')) continue
    if (profile.bundles.some((candidate) => candidate.name === bundle.name)) continue
    profile.bundles.push({
      name: bundle.name,
      version: bundle.version ?? '0.2.1-rc.3',
      official: true,
      availability: 'installation',
      installed: false,
      enabled: true,
      removable: false,
      optional: false,
      rows: [],
    })
  }
  const routes = createCtx(profile)
  const preview = await call(routes, 'preview', { method: 'POST', body: { code } })
  assert.equal(preview.status, 200, JSON.stringify(preview.json))
  const installs = preview.json.steps.filter((step) => step.kind === 'install')
  const expected = shared.bundles
    .filter((bundle) => !bundle.name.startsWith('@deepseek-ai/dsh-'))
    .filter((bundle) => !['alpha', 'beta', 'gamma'].includes(bundle.name))
  assert.equal(installs.length, expected.length, `install count ${installs.length} vs ${expected.length}`)
  assert.ok(installs.every((step) => !step.target.startsWith('@deepseek-ai/dsh-')))
  const configSteps = preview.json.steps.filter((step) => step.kind === 'config')
  assert.ok(configSteps.length >= 10, `config rows carried to the receiver: ${configSteps.length}`)
  console.log('ok: receiver plans', installs.length, 'installs and', configSteps.length, 'config writes; 0 shipped installs')
}

log('a reload colliding with the previous generation waits instead of failing')
{
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let held = 2
  const registered = []
  const ctx = {
    webServer: {
      register(route) {
        if (held > 0) {
          held -= 1
          throw new Error(`webserver: duplicate exact route "${route.path}"`)
        }
        registered.push(route)
        return () => {
          const index = registered.indexOf(route)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    get() {
      return undefined
    },
    inject() {
      return () => {}
    },
  }
  apply(ctx)
  assert.equal(registered.length, 0, 'nothing is registered while the previous generation still owns the paths')
  await delay(900)
  assert.equal(registered.length, 6, `every route registers once the paths free up (${registered.length})`)

  // The same context re-applying releases its own routes first instead of colliding.
  apply(ctx)
  assert.equal(registered.length, 6, 're-applying on the same context keeps exactly one registration per route')
  console.log('ok: duplicate-route collision retried, same-context re-apply is idempotent')
}

log('a non-duplicate registration failure is reported, not thrown into a timer')
{
  const ctx = {
    webServer: {
      register() {
        throw new Error('webserver: route table is closed')
      },
    },
    get(name) {
      if (name === 'logger') return { warn() {} }
      return undefined
    },
  }
  assert.throws(() => apply(ctx), /route table is closed/)
  console.log('ok: unrelated registration errors stay synchronous failures')
}

log('agent tools drive the same plan and apply engine')
{
  const sender = createProfile()
  const senderRoutes = createCtx(sender)
  const exported = await call(senderRoutes, 'export', { method: 'POST', body: { bundles: ['alpha'] } })

  const peer = createProfile()
  peer.installed = new Set()
  peer.defaultRows = new Map(peer.rows)
  peer.rows = new Map()
  const peerRoutes = createCtx(peer)

  const importTool = peerRoutes.tools.get('profile_share_import')
  const requirementsTool = peerRoutes.tools.get('profile_share_requirements')
  assert.ok(importTool !== undefined, 'profile_share_import registered')
  assert.ok(requirementsTool !== undefined, 'profile_share_requirements registered')
  assert.equal(importTool.parameters.required[0], 'code')

  const preview = await importTool.execute({ code: exported.json.code })
  assert.match(preview, /mode=preview/)
  assert.match(preview, /待执行：安装 1 个/)
  assert.equal(peer.installs.length, 0, 'preview must not install anything')

  const applied = await importTool.execute({ code: exported.json.code, apply: true })
  assert.match(applied, /mode=apply/)
  assert.match(applied, /changed=1/)
  assert.equal(peer.installs.length, 1, 'apply installs')

  const bad = await importTool.execute({ code: 'not-a-code' })
  assert.match(bad, /无法解析/)

  const requirements = await requirementsTool.execute({})
  assert.match(requirements, /\[dsh-profile-share\]/)
  console.log('ok: tools preview → apply → requirements; bad code reported, not thrown')
}

console.log('\nAll local smoke checks passed.')
