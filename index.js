/**
 * Host half of 分享与同步.
 *
 * Owns four things the browser cannot do itself:
 * 1. read the live profile inventory (bundles, rows, explicit config);
 * 2. pack a selection into one pasteable share code and unpack it again;
 * 3. plan and apply the delta against another profile through the public
 *    `pluginManager` and `configEditor` services;
 * 4. report the first-run requirements (secrets, environment variables, logins)
 *    that a freshly synced profile still has to satisfy.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { gzipSync, gunzipSync } from 'node:zlib'

const REQUIRE = createRequire(import.meta.url)

/** Share-code prefix; the version suffix lets a future format be rejected loudly. */
const CODE_PREFIX = 'DSH-SHARE/1:'
const ROUTE_BASE = '/api/dsh-profile-sync'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const WAIT_FOR_ENTRY_MS = 10_000
const POLL_INTERVAL_MS = 250

/** Bundle layers shipped inside the DSH installation itself. */
const INSTALLATION = 'installation'

export const name = 'dsh-profile-sync'
export const inject = ['webServer']

/** Route registrations owned by the context that activated this generation. */
const OWNED_ROUTES = new WeakMap()

/**
 * Register the share endpoints, tolerating a reload that starts before the
 * previous generation releases them: the Loader activates a new fiber and
 * disposes the old one afterwards, so the same `(kind, path)` is briefly
 * claimed twice. Failing activation there would leave this row failed until the
 * next restart, so a collision waits for the predecessor instead.
 * @param ctx - Cordis context that already injected `webServer`.
 * @returns Disposer removing every route owned by this generation.
 */
export function apply(ctx) {
  const previous = OWNED_ROUTES.get(ctx)
  if (previous !== undefined) {
    OWNED_ROUTES.delete(ctx)
    previous()
  }
  const dispose = mountRoutes(ctx)
  OWNED_ROUTES.set(ctx, dispose)
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(function* () {
      yield toolsCtx.tools.register(createImportTool(ctx))
      yield toolsCtx.tools.register(createRequirementsTool(ctx))
      yield toolsCtx.tools.register(createAuthorizeTool(ctx))
    }, 'dsh-profile-share: model tools')
  })
  return () => {
    OWNED_ROUTES.delete(ctx)
    dispose()
  }
}

function isDuplicateRoute(error) {
  return error instanceof Error && /duplicate exact route/i.test(error.message)
}

function mountRoutes(ctx) {
  const disposers = []
  let disposed = false
  let index = 0
  let attempts = 0

  const release = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Releasing a route the server already dropped is not a failure here.
      }
    }
  }

  const step = (synchronous) => {
    if (disposed) return
    while (index < ROUTES.length) {
      const [segment, handler] = ROUTES[index]
      try {
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/${segment}`,
          handler: (request, response) => respond(ctx, handler, request, response),
        }))
        index += 1
        attempts = 0
      } catch (error) {
        const retryable = isDuplicateRoute(error) && attempts < ROUTE_RETRY_LIMIT
        if (retryable) {
          attempts += 1
          setTimeout(() => step(false), ROUTE_RETRY_INTERVAL_MS)
          return
        }
        release()
        // A synchronous failure means activation itself is impossible; a late
        // one cannot throw from a timer, so it is reported instead.
        if (synchronous) throw error
        reportRouteFailure(ctx, error, attempts)
        return
      }
    }
  }

  step(true)
  return () => {
    disposed = true
    release()
  }
}

function reportRouteFailure(ctx, error, attempts) {
  const detail = error instanceof Error ? error.message : String(error)
  const line = `[dsh-profile-sync] 路由注册失败（重试 ${attempts} 次）：${detail}`
  const logger = ctx.get('logger')
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(line)
  else console.error(line)
}

const ROUTE_RETRY_INTERVAL_MS = 150
const ROUTE_RETRY_LIMIT = 80

const ROUTES = [
  ['state', handleState],
  ['export', handleExport],
  ['preview', handlePreview],
  ['apply', handleApply],
  ['requirements', handleRequirements],
  ['configure', handleConfigure],
  ['flows', handleFlows],
  ['authorize/start', handleAuthorizeStart],
  ['authorize/status', handleAuthorizeStatus],
  ['authorize/answer', handleAuthorizeAnswer],
  ['authorize/cancel', handleAuthorizeCancel],
]

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function respond(ctx, handler, request, response) {
  try {
    await handler(ctx, request, response)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    if (!response.headersSent) writeJson(response, status, { ok: false, error: message })
    else response.end()
  }
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const declared = Number(request.headers['content-length'] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, '请求内容过大。')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求内容过大。')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new HttpError(400, '请求内容不是合法的 JSON 对象。')
  }
}

/**
 * Reject cross-origin mutations and unauthenticated peers.
 * @returns `true` when the request may proceed; the response is already written otherwise.
 */
function admit(ctx, request, response, { mutation }) {
  const connection = ctx.get('connection')
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    let rejection
    try {
      rejection = connection.requestRejection(request)
    } catch {
      rejection = undefined
    }
    if (rejection !== undefined) {
      const status = typeof rejection === 'number' ? rejection : 403
      writeJson(response, status, { ok: false, error: '当前连接不允许该操作，请登录 DSH 后重试。' })
      return false
    }
  }
  if (!mutation) return true
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    writeJson(response, 415, { ok: false, error: '写操作必须以 application/json 提交。' })
    return false
  }
  const origin = request.headers.origin
  const host = request.headers.host
  if (typeof origin === 'string' && origin !== '' && typeof host === 'string' && host !== '') {
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      writeJson(response, 403, { ok: false, error: '来源不可识别，已拒绝写操作。' })
      return false
    }
    if (originHost !== host) {
      writeJson(response, 403, { ok: false, error: '跨来源写操作已被拒绝。' })
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

function services(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined) throw new HttpError(503, '当前 profile 未挂载 pluginManager，无法管理插件。')
  return {
    manager,
    editor: ctx.get('configEditor'),
  }
}

/**
 * The profile directory. The Host process does not inherit `DSH_PROFILE_DIR`
 * (only tool subprocesses do), so `profileContext` is the reliable source.
 * @param ctx - Cordis context.
 * @returns Absolute profile directory, or null.
 */
function profileDirectory(ctx) {
  const profile = ctx.get('profileContext')
  const directory = profile?.dir
  return typeof directory === 'string' && directory !== '' ? directory : null
}

function profileName(ctx) {
  const directory = profileDirectory(ctx)
  if (directory === null) return null
  const name = basename(directory)
  return name === '' ? null : name
}

/**
 * Version of the DSH installation backing this profile, for the share-code header.
 * @param ctx - Cordis context.
 * @returns Version string, or null when it cannot be read.
 */
function dshVersion(ctx) {
  const anchor = ctx.get('profileContext')?.installAnchor
  if (isRecord(anchor) && typeof anchor.version === 'string' && anchor.version !== '') return anchor.version
  if (typeof anchor === 'string' && anchor !== '') {
    for (const candidate of [join(anchor, 'package.json'), join(anchor, '..', 'package.json')]) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
        if (typeof manifest?.version === 'string' && manifest.version !== '') return manifest.version
      } catch {
        // Not every anchor names a package root; fall through to module resolution.
      }
    }
  }
  for (const specifier of ['@deepseek-ai/dsh-plugin-manager/package.json', '@deepseek-ai/dsh-app-boot/package.json']) {
    try {
      const manifest = REQUIRE(REQUIRE.resolve(specifier))
      if (typeof manifest?.version === 'string' && manifest.version !== '') return manifest.version
    } catch {
      // The package may be absent in a partial installation; the version is cosmetic.
    }
  }
  return null
}

/**
 * Dependency specs the profile itself declares, so non-registry installs
 * (`git+…`, `file:…`) keep their real source instead of a guessed `name@version`.
 * @param ctx - Cordis context.
 * @returns Map of package name to declared spec.
 */
function profileDependencies(ctx) {
  const directory = profileDirectory(ctx)
  if (directory === null) return new Map()
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (!isRecord(manifest?.dependencies)) return new Map()
    return new Map(Object.entries(manifest.dependencies).filter(([, spec]) => typeof spec === 'string'))
  } catch {
    return new Map()
  }
}

// ---------------------------------------------------------------------------
// Live inventory
// ---------------------------------------------------------------------------

/** Explicit profile rows keyed by their patch id. */
function rowMap(editor) {
  const rows = new Map()
  if (editor === undefined) return rows
  for (const { entry, inherited, override } of editor.configuration()) {
    const id = entry?.options?.id
    if (typeof id !== 'string' || id === '') continue
    const effective = isRecord(entry.options.config) ? entry.options.config : (isRecord(inherited) ? inherited : {})
    rows.set(id, {
      entry,
      id,
      name: typeof entry.options?.name === 'string' ? entry.options.name : null,
      inherited: isRecord(inherited) ? inherited : {},
      override: isRecord(override) ? override : {},
      effective,
    })
  }
  return rows
}

function rowEnabledMap(plugins) {
  const enabled = new Map()
  for (const plugin of plugins) {
    if (typeof plugin.patchId === 'string' && plugin.patchId !== '') enabled.set(plugin.patchId, plugin.enabled === true)
  }
  return enabled
}

function bundleMeta(bundle) {
  return {
    title: localizeText(bundle.meta?.title) ?? localizeText(bundle.description) ?? bundle.name,
    description: localizeText(bundle.meta?.description) ?? localizeText(bundle.description) ?? null,
  }
}

function localizeText(value) {
  if (typeof value === 'string') return value === '' ? null : value
  if (isRecord(value)) {
    for (const key of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
    for (const candidate of Object.values(value)) {
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
  }
  return null
}

function isInstallationBundle(bundle) {
  return bundle.availability === INSTALLATION
}

/** Bundles a profile owns and may therefore disable or remove. */
function isProfileBundle(bundle) {
  return bundle.availability === 'profile' && bundle.installed === true
}

async function readInventory(ctx) {
  const { manager, editor } = services(ctx)
  const bundles = await manager.listBundles()
  const plugins = await manager.listPlugins()
  const rows = rowMap(editor)
  const enabled = rowEnabledMap(plugins)
  return { bundles, plugins, rows, enabled, deps: profileDependencies(ctx) }
}

// ---------------------------------------------------------------------------
// GET /state
// ---------------------------------------------------------------------------

async function handleState(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: false })) return
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeJson(response, 405, { ok: false, error: '请使用 GET。' })
    return
  }
  const inventory = await readInventory(ctx)
  const bundles = inventory.bundles.map((bundle) => {
    const overrides = new Set(Array.isArray(bundle.overrides) ? bundle.overrides : [])
    return {
      ...bundleMeta(bundle),
      name: bundle.name,
      version: typeof bundle.version === 'string' ? bundle.version : null,
      enabled: bundle.enabled === true,
      installed: bundle.installed === true,
      availability: bundle.availability,
      official: bundle.official === true,
      removable: bundle.removable === true,
      optional: bundle.optional === true,
      readOnlyReason: bundle.readOnlyReason ?? null,
      error: bundle.error?.code ?? null,
      rows: (bundle.rows ?? []).map((row) => ({
        rowId: row.rowId,
        moduleName: row.moduleName,
        enabled: inventory.enabled.get(row.rowId) ?? true,
        hasOverride: overrides.has(row.rowId) || Object.keys(inventory.rows.get(row.rowId)?.override ?? {}).length > 0,
      })),
    }
  })
  const rowCount = bundles.reduce((total, bundle) => total + bundle.rows.length, 0)
  writeJson(response, 200, {
    ok: true,
    profile: {
      name: profileName(ctx),
      dshVersion: dshVersion(ctx),
      appUrl: process.env.DSH_WEB_URL ?? null,
    },
    bundles,
    counts: { bundles: bundles.length, rows: rowCount },
  })
}

// ---------------------------------------------------------------------------
// Share code
// ---------------------------------------------------------------------------

/**
 * Encode a snapshot as one pasteable line.
 * @param payload - Snapshot object.
 * @returns Prefixed base64url string.
 */
function encodeCode(payload) {
  const packed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 })
  return `${CODE_PREFIX}${packed.toString('base64url')}`
}

/**
 * Decode and validate a share code.
 * @param code - Text pasted by the user.
 * @returns The snapshot.
 */
function decodeCode(code) {
  if (typeof code !== 'string' || code.trim() === '') throw new HttpError(400, '分享码为空。')
  const compact = code.trim().replace(/\s+/g, '')
  if (!compact.startsWith(CODE_PREFIX)) {
    throw new HttpError(400, '这不是本插件生成的分享码（应以 DSH-SHARE/1: 开头）。')
  }
  let raw
  try {
    raw = gunzipSync(Buffer.from(compact.slice(CODE_PREFIX.length), 'base64url')).toString('utf8')
  } catch {
    throw new HttpError(400, '分享码不完整或已损坏，请重新复制。')
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new HttpError(400, '分享码内容不是合法 JSON。')
  }
  return validatePayload(payload)
}

function validatePayload(payload) {
  if (!isRecord(payload)) throw new HttpError(400, '分享码结构无效。')
  if (payload.v !== 1) throw new HttpError(400, `分享码版本 ${String(payload.v)} 不受支持。`)
  if (!Array.isArray(payload.bundles)) throw new HttpError(400, '分享码缺少插件列表。')
  const bundles = []
  for (const bundle of payload.bundles) {
    if (!isRecord(bundle) || typeof bundle.name !== 'string' || bundle.name === '') continue
    const rows = []
    if (Array.isArray(bundle.rows)) {
      for (const row of bundle.rows) {
        if (!isRecord(row) || typeof row.id !== 'string' || row.id === '') continue
        rows.push({
          id: row.id,
          module: typeof row.module === 'string' ? row.module : null,
          enabled: row.enabled !== false,
          config: isRecord(row.config) ? row.config : {},
        })
      }
    }
    bundles.push({
      name: bundle.name,
      version: typeof bundle.version === 'string' ? bundle.version : null,
      spec: typeof bundle.spec === 'string' ? bundle.spec : null,
      shipped: bundle.shipped === true,
      enabled: bundle.enabled !== false,
      rows,
    })
  }
  return {
    v: 1,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : null,
    source: isRecord(payload.source) ? payload.source : {},
    bundles,
  }
}

function specOf(bundle, deps) {
  const declared = deps === undefined ? undefined : deps.get(bundle.name)
  if (typeof declared === 'string' && declared !== '') return declared
  if (typeof bundle.spec === 'string' && bundle.spec !== '') return bundle.spec
  if (typeof bundle.installTarget?.spec === 'string' && bundle.installTarget.spec !== '') return bundle.installTarget.spec
  if (typeof bundle.version === 'string' && bundle.version !== '') return `${bundle.name}@${bundle.version}`
  return bundle.name
}

/**
 * The spec to hand `installBundle`. Registry declarations are pinned to the
 * shared version; `git+…`, `file:…` and other non-registry declarations are
 * passed through unchanged, because a `name@version` guess would not resolve.
 * @param bundle - Bundle entry from a share code.
 * @returns Installable package spec.
 */
function installSpecFor(bundle) {
  const declared = typeof bundle.spec === 'string' && bundle.spec !== '' ? bundle.spec : bundle.name
  const registryLike = declared === bundle.name || declared.startsWith(`${bundle.name}@`)
  if (!registryLike) return declared
  return typeof bundle.version === 'string' && bundle.version !== '' ? `${bundle.name}@${bundle.version}` : bundle.name
}

// ---------------------------------------------------------------------------
// POST /export
// ---------------------------------------------------------------------------

async function handleExport(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: true })) return
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const body = await readJson(request)
  const names = Array.isArray(body.bundles) ? body.bundles.filter((name) => typeof name === 'string' && name !== '') : []
  if (names.length === 0) throw new HttpError(400, '请至少勾选一个插件。')
  const includeSecrets = body.includeSecrets === true
  const inventory = await readInventory(ctx)
  const selected = new Set(names)
  const unknown = names.filter((name) => !inventory.bundles.some((bundle) => bundle.name === name))
  if (unknown.length === names.length) throw new HttpError(400, '勾选的插件已不在当前 profile 中，请刷新后重试。')

  const stopped = []
  const bundles = []
  const uninstalled = []
  for (const bundle of inventory.bundles) {
    if (!selected.has(bundle.name)) continue
    const shipped = isInstallationBundle(bundle)
    if (!shipped && bundle.installed !== true) {
      // A bundle the sender does not run contributes nothing to "copy my DSH";
      // sharing it would only ask the receiver to install a package the sender
      // itself never loaded.
      uninstalled.push(bundle.name)
      continue
    }
    const rows = []
    for (const row of bundle.rows ?? []) {
      const info = inventory.rows.get(row.rowId)
      const override = info?.override ?? {}
      if (Object.keys(override).length === 0) continue
      const exported = includeSecrets ? override : stripSecrets(override, row.rowId, stopped)
      if (Object.keys(exported).length === 0) continue
      rows.push({
        id: row.rowId,
        module: row.moduleName ?? null,
        enabled: inventory.enabled.get(row.rowId) ?? true,
        config: exported,
      })
    }
    bundles.push({
      name: bundle.name,
      version: typeof bundle.version === 'string' ? bundle.version : null,
      spec: specOf(bundle, inventory.deps),
      shipped: isInstallationBundle(bundle),
      enabled: bundle.enabled === true,
      rows,
    })
  }

  if (bundles.length === 0) {
    throw new HttpError(400, `选中的插件都还没有安装，无法生成分享码：${uninstalled.join('、')}`)
  }

  const payload = {
    v: 1,
    createdAt: new Date().toISOString(),
    source: { profile: profileName(ctx), dshVersion: dshVersion(ctx), platform: process.platform },
    bundles,
  }
  const code = encodeCode(payload)
  const rowCount = bundles.reduce((total, bundle) => total + bundle.rows.length, 0)
  writeJson(response, 200, {
    ok: true,
    code,
    stats: {
      bundles: bundles.length,
      rows: rowCount,
      bytes: code.length,
      stripped: stopped,
      unknown,
      uninstalled,
    },
  })
}

const SECRET_WORDS = new Set([
  'apikey', 'accesskey', 'secretkey', 'secret', 'clientsecret', 'password', 'passwd',
  'passphrase', 'authorization', 'bearer', 'cookie', 'privatekey', 'credential',
  'credentials', 'accesstoken', 'refreshtoken', 'authtoken', 'sessionkey', 'secretaccesskey',
])
const COUNT_LIKE = /(max|min|context|limit|count|size|cost|usage|total|input|output|reasoning|budget|window)/

/**
 * Whether a config key names a value that must not leave this machine.
 * @param key - Config key name.
 * @returns True for credential-bearing keys.
 */
function isSecretKey(key) {
  const normalized = String(key).toLowerCase().replace(/[-_\s]/g, '')
  if (SECRET_WORDS.has(normalized)) return true
  if (COUNT_LIKE.test(normalized)) return false
  return normalized.endsWith('apikey') || normalized.endsWith('secret') || normalized.endsWith('token')
}

/**
 * Whether a config key names an environment variable holding a credential.
 * @param key - Config key name.
 * @returns True for `*Env` keys.
 */
function isEnvKey(key) {
  return /env$/i.test(String(key)) && !/^env$/i.test(String(key))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripSecrets(value, prefix, removed) {
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    const path = `${prefix}.${key}`
    if (isSecretKey(key) && !isRecord(entry)) {
      removed.push(path)
      continue
    }
    if (isRecord(entry)) out[key] = stripSecrets(entry, path, removed)
    else out[key] = entry
  }
  return out
}

// ---------------------------------------------------------------------------
// Deep helpers
// ---------------------------------------------------------------------------

function deepMerge(base, patch) {
  if (!isRecord(base) || !isRecord(patch)) return structuredClone(patch)
  const out = structuredClone(base)
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isRecord(value) && isRecord(out[key]) ? deepMerge(out[key], value) : structuredClone(value)
  }
  return out
}

/**
 * Whether `actual` already carries every value `expected` declares.
 * @param actual - Current effective config.
 * @param expected - Values from the share code.
 * @returns True when nothing would change.
 */
function covers(actual, expected) {
  if (!isRecord(expected)) return isDeepStrictEqual(actual, expected)
  if (!isRecord(actual)) return false
  return Object.entries(expected).every(([key, value]) => covers(actual[key], value))
}

function differingKeys(actual, expected, limit = 3) {
  const keys = []
  const walk = (left, right, prefix) => {
    if (keys.length >= limit) return
    if (!isRecord(right)) {
      if (!isDeepStrictEqual(left, right)) keys.push(prefix)
      return
    }
    for (const [key, value] of Object.entries(right)) {
      walk(isRecord(left) ? left[key] : undefined, value, prefix === '' ? key : `${prefix}.${key}`)
      if (keys.length >= limit) return
    }
  }
  walk(actual, expected, '')
  return keys
}

function setPath(target, path, value) {
  const segments = String(path).split('.').filter((segment) => segment !== '')
  if (segments.length === 0) throw new HttpError(400, '配置路径无效。')
  const out = structuredClone(target)
  let cursor = out
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(cursor[segment])) cursor[segment] = {}
    cursor = cursor[segment]
  }
  cursor[segments.at(-1)] = value
  return out
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Compare a share code with the live profile.
 * @param ctx - Cordis context.
 * @param payload - Validated snapshot.
 * @param fullAlign - Also disable profile bundles the code does not contain.
 * @returns Steps the apply run would execute, plus a summary.
 */
async function buildPlan(ctx, payload, fullAlign) {
  const inventory = await readInventory(ctx)
  const localBundles = new Map(inventory.bundles.map((bundle) => [bundle.name, bundle]))
  const inCode = new Set(payload.bundles.map((bundle) => bundle.name))
  const steps = []

  for (const bundle of payload.bundles) {
    const local = localBundles.get(bundle.name)
    const shippedHere = local !== undefined && isInstallationBundle(local)
    const present = local !== undefined
      && (shippedHere || (local.installed === true && local.availability !== 'missing'))
    if (present) {
      const localVersion = typeof local.version === 'string' ? local.version : null
      if (!shippedHere && localVersion !== null && bundle.version !== null && localVersion !== bundle.version) {
        steps.push({
          kind: 'install',
          target: bundle.name,
          detail: `版本 ${localVersion} → ${bundle.version}`,
          status: 'pending',
          spec: installSpecFor(bundle),
          name: bundle.name,
        })
      } else {
        steps.push({
          kind: 'skip',
          target: bundle.name,
          detail: shippedHere ? `随 DSH 安装 ${localVersion ?? ''}`.trim() : `已安装 ${localVersion ?? ''}`.trim(),
          status: 'satisfied',
        })
      }
      if (bundle.enabled && local.enabled !== true) {
        steps.push({ kind: 'enable', target: bundle.name, detail: '当前已禁用', status: 'pending' })
      } else if (!bundle.enabled && local.enabled === true && fullAlign && isProfileBundle(local)) {
        steps.push({ kind: 'disable', target: bundle.name, detail: '码中已禁用', status: 'pending' })
      }
      continue
    }
    if (bundle.shipped === true) {
      steps.push({ kind: 'skip', target: bundle.name, detail: '随 DSH 安装，无需单独安装', status: 'satisfied' })
      continue
    }
    const spec = installSpecFor(bundle)
    steps.push({
      kind: 'install',
      target: bundle.name,
      detail: `未安装 · 将安装 ${spec}`,
      status: 'pending',
      spec,
      name: bundle.name,
    })
  }

  if (fullAlign) {
    for (const local of inventory.bundles) {
      if (!isProfileBundle(local) || local.enabled !== true) continue
      if (inCode.has(local.name)) continue
      steps.push({ kind: 'disable', target: local.name, detail: '码中未包含 · 完整对齐会禁用', status: 'pending' })
    }
  }

  for (const bundle of payload.bundles) {
    for (const row of bundle.rows) {
      const info = inventory.rows.get(row.id)
      if (info !== undefined) {
        const currentlyEnabled = inventory.enabled.get(row.id)
        if (currentlyEnabled !== undefined && currentlyEnabled !== row.enabled) {
          steps.push({
            kind: row.enabled ? 'enable' : 'disable',
            target: row.id,
            detail: row.enabled ? '该行当前已禁用' : '该行当前已启用',
            status: 'pending',
            patchId: row.id,
          })
        }
      }
      if (Object.keys(row.config).length === 0) continue
      if (info !== undefined) {
        if (covers(info.effective, row.config)) {
          steps.push({ kind: 'config', target: row.id, detail: '配置已一致', status: 'satisfied' })
          continue
        }
        const keys = differingKeys(info.effective, row.config)
        steps.push({
          kind: 'config',
          target: row.id,
          detail: keys.length === 0 ? '配置存在差异' : `将写入 ${keys.join('、')}`,
          status: 'pending',
          patchId: row.id,
          config: row.config,
        })
        continue
      }
      if (row.enabled === false) {
        steps.push({ kind: 'skip', target: row.id, detail: '该行在码中已禁用', status: 'satisfied' })
        continue
      }
      steps.push({
        kind: 'config',
        target: row.id,
        detail: '插件启用后写入（可能需要重启）',
        status: 'pending',
        patchId: row.id,
        config: row.config,
        awaitEntry: true,
      })
    }
  }

  const pending = steps.filter((step) => step.status === 'pending')
  return {
    steps,
    summary: {
      install: pending.filter((step) => step.kind === 'install').length,
      bundleToggle: pending.filter((step) => step.kind === 'enable' || step.kind === 'disable').length,
      config: pending.filter((step) => step.kind === 'config').length,
    },
  }
}

async function handlePreview(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: true })) return
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const body = await readJson(request)
  const payload = decodeCode(body.code)
  const plan = await buildPlan(ctx, payload, body.fullAlign === true)
  const rowCount = payload.bundles.reduce((total, bundle) => total + bundle.rows.length, 0)
  writeJson(response, 200, {
    ok: true,
    manifest: {
      createdAt: payload.createdAt,
      source: payload.source,
      bundles: payload.bundles.map((bundle) => ({ name: bundle.name, version: bundle.version, enabled: bundle.enabled })),
      rowCount,
    },
    steps: plan.steps,
    summary: plan.summary,
  })
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

async function waitForEntry(ctx, patchId) {
  const deadline = Date.now() + WAIT_FOR_ENTRY_MS
  while (Date.now() < deadline) {
    const { editor } = services(ctx)
    if (editor !== undefined && editor.entries().some((entry) => entry?.options?.id === patchId)) return true
    await delay(POLL_INTERVAL_MS)
  }
  return false
}

async function writeConfig(ctx, patchId, config) {
  return await applyRowConfig(ctx, patchId, config)
}

/**
 * Merge values into one row's effective config and persist them through the
 * profile patch, so schema validation, the profile file lock, and Loader
 * reconciliation all run on the official path.
 * @param ctx - Context exposing `configEditor`.
 * @param patchId - The row's profile patch id.
 * @param config - Values to merge over the current effective config.
 * @returns Whether the profile changed.
 */
export async function applyRowConfig(ctx, patchId, config) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) throw new Error('当前 profile 未挂载 configEditor，无法写入配置。')
  const entry = editor.entries().find((candidate) => candidate?.options?.id === patchId)
  if (entry === undefined) throw new Error('插件当前未挂载（可能仍需重启 DSH）')
  const current = isRecord(entry.options.config) ? entry.options.config : {}
  const next = deepMerge(current, config)
  if (isDeepStrictEqual(next, current)) return false
  await editor.edit(entry, () => next)
  return true
}

/**
 * Read one row's current effective config without writing anything.
 * @param ctx - Context exposing `configEditor`.
 * @param patchId - The row's profile patch id.
 * @returns The effective config, or null when the row is not mounted.
 */
export function readRowConfig(ctx, patchId) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) return null
  const entry = editor.entries().find((candidate) => candidate?.options?.id === patchId)
  if (entry === undefined) return null
  return isRecord(entry.options.config) ? entry.options.config : {}
}

async function handleApply(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: true })) return
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const body = await readJson(request)
  const payload = decodeCode(body.code)
  const outcome = await runApply(ctx, payload, body.fullAlign === true)
  writeJson(response, 200, {
    ok: true,
    changed: outcome.changed,
    restartRequired: outcome.restartRequired,
    results: outcome.results,
  })
}

/**
 * Plan a snapshot against this profile and execute every pending step.
 * @param ctx - Cordis context.
 * @param payload - Validated snapshot.
 * @param fullAlign - Also disable profile bundles the code does not contain.
 * @returns The plan, its executed steps, the change count, and whether a restart is needed.
 */
async function runApply(ctx, payload, fullAlign) {
  const plan = await buildPlan(ctx, payload, fullAlign)
  const { manager } = services(ctx)
  const results = []
  let restartRequired = false
  let changed = 0

  for (const step of plan.steps) {
    if (step.status === 'satisfied') {
      results.push({ kind: step.kind, target: step.target, status: 'skipped', detail: step.detail })
      continue
    }
    try {
      if (step.kind === 'install') {
        const outcome = await manager.installBundle(step.spec ?? step.target, { enabled: true })
        if (outcome?.application === 'failed') {
          throw new Error(outcome?.error?.diagnostic ?? outcome?.error?.code ?? '安装失败')
        }
        if (outcome?.application === 'restart-required') restartRequired = true
        if (Array.isArray(outcome?.pendingBuilds) && outcome.pendingBuilds.length > 0) {
          results.push({
            kind: 'install',
            target: step.target,
            status: 'failed',
            error: `需要先确认构建脚本：${outcome.pendingBuilds.join(', ')}`,
          })
          continue
        }
        changed += 1
        results.push({ kind: 'install', target: step.target, status: 'applied', detail: step.detail })
        continue
      }
      if (step.kind === 'enable' || step.kind === 'disable') {
        const enabled = step.kind === 'enable'
        const outcome = step.patchId === undefined
          ? await manager.setBundleEnabled(step.target, enabled)
          : await manager.setPluginEnabled(step.patchId, enabled)
        if (outcome?.application === 'failed') throw new Error(outcome?.error?.code ?? '切换失败')
        if (outcome?.application === 'restart-required') restartRequired = true
        changed += 1
        results.push({ kind: step.kind, target: step.target, status: 'applied', detail: step.detail })
        continue
      }
      if (step.kind === 'config') {
        if (step.awaitEntry === true) await waitForEntry(ctx, step.patchId)
        const written = await writeConfig(ctx, step.patchId, step.config)
        if (written) changed += 1
        results.push({
          kind: 'config',
          target: step.target,
          status: written ? 'applied' : 'skipped',
          detail: step.detail,
        })
        continue
      }
      results.push({ kind: step.kind, target: step.target, status: 'skipped', detail: step.detail })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/no longer|changed during reload|restart/i.test(message)) restartRequired = true
      results.push({ kind: step.kind, target: step.target, status: 'failed', error: message })
    }
  }

  return { plan, results, changed, restartRequired }
}

// ---------------------------------------------------------------------------
// First-run requirements
// ---------------------------------------------------------------------------

function schemaFields(schema, prefix, out, depth = 0) {
  if (depth > 6 || schema === undefined || schema === null) return
  let dictionary = null
  if (isRecord(schema?.dict)) dictionary = schema.dict
  else if (isRecord(schema?._def?.shape)) dictionary = schema._def.shape
  if (dictionary !== null) {
    for (const [key, child] of Object.entries(dictionary)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      schemaFields(child, path, out, depth + 1)
    }
    return
  }
  if (prefix !== '') {
    const description = typeof schema?.description === 'string' && schema.description !== ''
      ? schema.description
      : undefined
    out.push({ path: prefix, description })
  }
}

function entrySchema(entry) {
  try {
    const schema = entry?.fiber?.runtime?.Config
    if (schema === undefined || schema === null) return []
    const out = []
    schemaFields(schema, '', out)
    return out
  } catch {
    return []
  }
}

function bundleOfRow(inventory, patchId) {
  for (const bundle of inventory.bundles) {
    if ((bundle.rows ?? []).some((row) => row.rowId === patchId)) return bundle
  }
  return undefined
}

const LOGIN_KEY = /^(login|loggedin|oauth|authorization|authorized|account|accounts|signin|subscription|subscriptions|connectors|connector|cookie|session|cookieJar)$/i

/**
 * Where each well-known provider hands out credentials. Matched against the
 * environment variable name, the configured base URL, the row id and the bundle
 * name, so an `apiKeyEnv` next to a DashScope base URL still finds DashScope.
 */
const PROVIDER_GUIDES = [
  { match: /deepseek/i, label: 'DeepSeek 开放平台', applyUrl: 'https://platform.deepseek.com/api_keys', note: '在「API keys」页创建密钥，复制形如 sk-… 的字符串。' },
  { match: /dashscope|bailian|qwen|aliyun|token-plan/i, label: '阿里云百炼（DashScope）', applyUrl: 'https://bailian.console.aliyun.com/', note: '在控制台「API-KEY」页创建密钥，形如 sk-…。' },
  { match: /anthropic|claude/i, label: 'Anthropic 控制台', applyUrl: 'https://console.anthropic.com/settings/keys', note: '创建 API key 后复制。' },
  { match: /gemini|google/i, label: 'Google AI Studio', applyUrl: 'https://aistudio.google.com/app/apikey', note: '创建 API key 后复制。' },
  { match: /moonshot|kimi/i, label: '月之暗面开放平台', applyUrl: 'https://platform.moonshot.cn/console/api-keys', note: '创建密钥后复制。' },
  { match: /zhipu|bigmodel|glm/i, label: '智谱开放平台', applyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', note: '创建 API Key 后复制。' },
  { match: /minimax/i, label: 'MiniMax 开放平台', applyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', note: '创建接口密钥后复制。' },
  { match: /siliconflow/i, label: '硅基流动', applyUrl: 'https://cloud.siliconflow.cn/account/ak', note: '创建 API 密钥后复制。' },
  { match: /openrouter/i, label: 'OpenRouter', applyUrl: 'https://openrouter.ai/keys', note: '创建 key 后复制。' },
  { match: /volc|ark|doubao/i, label: '火山方舟', applyUrl: 'https://console.volcengine.com/ark', note: '开通后在「API Key 管理」创建。' },
  { match: /groq/i, label: 'Groq Console', applyUrl: 'https://console.groq.com/keys', note: '创建 API key 后复制。' },
  { match: /workbuddy/i, label: 'WorkBuddy', applyUrl: 'https://www.workbuddy.cn/', note: '登录后在账号设置里获取接入凭据。' },
  { match: /openai/i, label: 'OpenAI 平台', applyUrl: 'https://platform.openai.com/api-keys', note: '创建 Secret key，形如 sk-…。' },
]

function environmentCommands(envName) {
  return [
    { os: 'windows', label: 'Windows（永久，改完要重启 DSH）', command: `setx ${envName} "你的值"` },
    { os: 'powershell', label: 'PowerShell（仅当前会话）', command: `$env:${envName} = "你的值"` },
    { os: 'unix', label: 'macOS / Linux（写进 shell 配置后重开终端）', command: `export ${envName}=你的值` },
  ]
}

/**
 * Turn one requirement into instructions: where to get the value, what to do
 * with it, and what the schema itself says about the field.
 * @param wanted - `{ haystack, envName, hint, kind }` for the requirement.
 * @returns Guidance object for the UI and the agent tools.
 */
function resolveGuidance(wanted) {
  const provider = PROVIDER_GUIDES.find((entry) => entry.match.test(wanted.haystack))
  const guidance = {
    provider: provider?.label ?? null,
    applyUrl: provider?.applyUrl ?? null,
    note: provider?.note ?? null,
    hint: wanted.hint ?? null,
    commands: wanted.kind === 'env' && wanted.envName !== undefined
      ? environmentCommands(wanted.envName)
      : [],
  }
  if (wanted.kind === 'login') {
    guidance.note = '该插件需要登录或授权才能用。若下方「可一键授权」里有对应条目，点一下即可；否则到该插件自己的设置页完成登录。'
  }
  if (guidance.applyUrl === null && guidance.note === null && guidance.hint === null && guidance.commands.length === 0) {
    guidance.note = '该字段由插件自行定义，申请方式见该插件的说明或它自己的设置页。'
  }
  return guidance
}

/**
 * Match one requirement to an authorization flow this profile already
 * registers, so the page can offer a button instead of a bare input.
 * @param flowKeys - Keys of the registered flows.
 * @param rowId - The row's patch id.
 * @param path - The requirement's config path.
 * @returns The matching flow key, or null.
 */
function authorizeBinding(flowKeys, rowId, path) {
  const segments = String(path).split('.')
  const at = segments.indexOf('providers')
  const candidate = at >= 0 && segments.length > at + 1
    ? `${rowId}/${segments[at + 1]}`
    : `${rowId}/default`
  return flowKeys.has(candidate) ? candidate : null
}

/**
 * Collect what still needs a human on this machine.
 * @param ctx - Cordis context.
 * @returns Requirement items for the guided page.
 */
async function collectRequirements(ctx) {
  const inventory = await readInventory(ctx)
  const flowKeys = new Set(readFlows(ctx).map((flow) => flow.key))
  const items = []
  for (const info of inventory.rows.values()) {
    const bundle = bundleOfRow(inventory, info.id)
    const title = bundle === undefined
      ? (info.name ?? info.id)
      : (localizeText(bundle.meta?.title) ?? bundle.name)
    const effective = info.effective
    const fromSchema = entrySchema(info.entry)
    const seen = new Set()

    for (const { path, description } of fromSchema) {
      const key = path.split('.').at(-1) ?? path
      if (isSecretKey(key)) {
        const value = readPath(effective, path)
        if (value === undefined || value === null || value === '') {
          seen.add(path)
          items.push({
            entryId: info.id,
            bundle: bundle?.name ?? null,
            rowId: info.id,
            title,
            kind: 'secret',
            path,
            label: `${title} · ${path}`,
            status: 'missing',
            authorize: authorizeBinding(flowKeys, info.id, path),
            guidance: resolveGuidance({
              haystack: `${info.id} ${path} ${bundle?.name ?? ''}`,
              hint: description,
              kind: 'secret',
            }),
          })
        }
      }
    }

    walkConfig(effective, '', (key, path, value, parent) => {
      const baseURL = isRecord(parent) && typeof parent.baseURL === 'string' ? parent.baseURL : ''
      const haystack = `${baseURL} ${info.id} ${bundle?.name ?? ''} ${bundle?.meta?.title ?? ''}`
      if (isEnvKey(key) && typeof value === 'string' && value !== '') {
        const present = typeof process.env[value] === 'string' && process.env[value] !== ''
        items.push({
          entryId: info.id,
          bundle: bundle?.name ?? null,
          rowId: info.id,
          title,
          kind: 'env',
          path,
          label: `${title} · ${value}`,
          status: present ? 'ready' : 'missing',
          envName: value,
          authorize: authorizeBinding(flowKeys, info.id, path),
          guidance: resolveGuidance({ haystack: `${value} ${haystack}`, envName: value, kind: 'env' }),
        })
        return
      }
      if (isSecretKey(key) && !isRecord(value) && path !== '') {
        if (seen.has(path)) return
        const missing = value === undefined || value === null || value === ''
        items.push({
          entryId: info.id,
          bundle: bundle?.name ?? null,
          rowId: info.id,
          title,
          kind: 'secret',
          path,
          label: `${title} · ${path}`,
          status: missing ? 'missing' : 'ready',
          authorize: authorizeBinding(flowKeys, info.id, path),
          guidance: resolveGuidance({ haystack: `${key} ${path} ${haystack}`, kind: 'secret' }),
        })
        return
      }
      if (LOGIN_KEY.test(String(key)) && (value === '' || value === null || value === undefined || value === 'ask' || value === 'none')) {
        items.push({
          entryId: info.id,
          bundle: bundle?.name ?? null,
          rowId: info.id,
          title,
          kind: 'login',
          path,
          label: `${title} · ${path}`,
          status: 'manual',
          authorize: authorizeBinding(flowKeys, info.id, path),
          guidance: resolveGuidance({ haystack: `${key} ${haystack}`, kind: 'login' }),
        })
      }
    })
  }
  return items
}

function walkConfig(value, prefix, visit, depth = 0) {
  if (depth > 6 || !isRecord(value)) return
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    visit(key, path, entry, value)
    if (isRecord(entry)) walkConfig(entry, path, visit, depth + 1)
  }
}

function readPath(value, path) {
  let cursor = value
  for (const segment of String(path).split('.')) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

async function handleRequirements(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: false })) return
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeJson(response, 405, { ok: false, error: '请使用 GET。' })
    return
  }
  const items = await collectRequirements(ctx)
  writeJson(response, 200, { ok: true, items, flows: readFlows(ctx), attempt: attemptView() })
}

async function handleConfigure(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: true })) return
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const body = await readJson(request)
  const entryId = typeof body.entryId === 'string' ? body.entryId : ''
  const path = typeof body.path === 'string' ? body.path : ''
  const value = typeof body.value === 'string' ? body.value.trim() : ''
  if (entryId === '' || path === '') throw new HttpError(400, '缺少要写入的条目或字段。')
  if (value === '') throw new HttpError(400, '请填写要保存的值。')

  const items = await collectRequirements(ctx)
  const target = items.find((item) => item.entryId === entryId && item.path === path && item.kind === 'secret')
  if (target === undefined) throw new HttpError(400, '该字段不是可写入的密钥项，请刷新后重试。')

  const { editor } = services(ctx)
  if (editor === undefined) throw new HttpError(503, '当前 profile 未挂载 configEditor，无法写入配置。')
  const entry = editor.entries().find((candidate) => candidate?.options?.id === entryId)
  if (entry === undefined) throw new HttpError(409, '该插件当前未挂载，无法写入配置。')
  const current = isRecord(entry.options.config) ? entry.options.config : {}
  const next = setPath(current, path, value)
  await editor.edit(entry, () => next)
  writeJson(response, 200, { ok: true, changed: true })
}

// ---------------------------------------------------------------------------
// One-click authorization (ctx.authorization flows)
// ---------------------------------------------------------------------------

/** At most one authorization attempt runs at a time for the whole profile. */
const AUTHORIZATION_ATTEMPT = { current: null }

function attemptView() {
  const attempt = AUTHORIZATION_ATTEMPT.current
  if (attempt === null) return null
  const view = {
    key: attempt.key,
    label: attempt.label,
    status: attempt.status,
    notices: attempt.notices,
    error: attempt.error,
    startedAt: attempt.startedAt,
  }
  if (attempt.pending !== null && attempt.pending !== undefined) {
    view.pending = {
      id: attempt.pending.id,
      kind: attempt.pending.kind,
      message: attempt.pending.message,
      placeholder: attempt.pending.placeholder ?? null,
      options: attempt.pending.options ?? [],
    }
  }
  return view
}

/**
 * Flows this profile can start on the user's behalf.
 * @param ctx - Cordis context.
 * @returns One entry per registered authorization flow.
 */
function readFlows(ctx) {
  const authorization = ctx.get('authorization')
  if (authorization === undefined) return []
  try {
    return authorization.list().map((entry) => ({
      key: String(entry.key),
      label: entry.label,
      methods: (entry.methods ?? []).map((method) => ({ id: method.id, label: method.label })),
      inFlight: entry.inFlight === true,
    }))
  } catch {
    return []
  }
}

async function handleFlows(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: false })) return
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeJson(response, 405, { ok: false, error: '请使用 GET。' })
    return
  }
  writeJson(response, 200, { ok: true, flows: readFlows(ctx), attempt: attemptView() })
}

async function handleAuthorizeStart(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: true })) return
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const body = await readJson(request)
  const attempt = await beginAuthorization(ctx, body.key, body.method)
  writeJson(response, 202, { ok: true, attempt })
}

/**
 * Start one authorization flow and keep its notices for the UI to poll.
 * @param ctx - Cordis context.
 * @param key - Credential key from `readFlows`.
 * @param method - Optional method id the flow offers.
 * @returns The attempt's public view.
 */
async function beginAuthorization(ctx, key, method) {
  const authorization = ctx.get('authorization')
  if (authorization === undefined) throw new HttpError(503, '当前 profile 未挂载 authorization，无法一键授权。')
  if (typeof key !== 'string' || key === '') throw new HttpError(400, '缺少要授权的凭据键。')
  const entry = authorization.describe(key)
  if (entry === undefined) throw new HttpError(404, '该授权入口已不存在，请刷新后重试。')
  if (AUTHORIZATION_ATTEMPT.current !== null && AUTHORIZATION_ATTEMPT.current.status === 'running') {
    throw new HttpError(409, '已有一个授权流程在进行，请先等它结束或取消。')
  }

  const attempt = {
    key,
    label: entry.label,
    status: 'running',
    notices: [],
    error: null,
    startedAt: new Date().toISOString(),
    controller: new AbortController(),
    pending: null,
    resolve: null,
    reject: null,
  }
  AUTHORIZATION_ATTEMPT.current = attempt

  let promptSeq = 0
  const interaction = {
    notify(notice) {
      attempt.notices.push({ message: notice.message, url: notice.url ?? null, code: notice.code ?? null })
    },
    prompt(prompt) {
      // The flow asks the human something (usually the key itself). Hold the
      // flow here, expose the question through the polled attempt, and resume
      // it when the page posts the answer.
      const id = `p${(promptSeq += 1)}`
      return new Promise((resolve, reject) => {
        const clear = () => {
          attempt.pending = null
          attempt.resolve = null
          attempt.reject = null
        }
        attempt.pending = {
          id,
          kind: typeof prompt.kind === 'string' ? prompt.kind : 'text',
          message: typeof prompt.message === 'string' ? prompt.message : '请填写授权所需的信息',
          placeholder: typeof prompt.placeholder === 'string' ? prompt.placeholder : null,
          options: Array.isArray(prompt.options) ? prompt.options : [],
        }
        attempt.resolve = (value) => {
          clear()
          resolve(value)
        }
        attempt.reject = (error) => {
          clear()
          reject(error)
        }
        if (prompt.signal !== undefined && prompt.signal !== null && typeof prompt.signal.addEventListener === 'function') {
          prompt.signal.addEventListener('abort', () => {
            if (attempt.pending !== null && attempt.pending !== undefined && attempt.pending.id === id) {
              clear()
              reject(new Error('授权已取消'))
            }
          }, { once: true })
        }
      })
    },
  }

  void authorization.begin({
    key,
    method: typeof method === 'string' && method !== '' ? method : undefined,
    interaction,
    signal: attempt.controller.signal,
  })
    .then((outcome) => {
      attempt.status = outcome.status === 'authorized' ? 'authorized' : 'cancelled'
    })
    .catch((error) => {
      attempt.status = attempt.controller.signal.aborted ? 'cancelled' : 'failed'
      if (attempt.status === 'failed') attempt.error = error instanceof Error ? error.message : String(error)
    })
    .finally(() => {
      // The settled attempt stays readable so a poll after a fast flow still
      // reports its outcome; the next start replaces it.
      attempt.settledAt = new Date().toISOString()
    })

  return attemptView()
}

async function handleAuthorizeStatus(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: false })) return
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeJson(response, 405, { ok: false, error: '请使用 GET。' })
    return
  }
  writeJson(response, 200, { ok: true, attempt: attemptView() })
}

async function handleAuthorizeCancel(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: true })) return
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const attempt = AUTHORIZATION_ATTEMPT.current
  if (attempt === null || attempt.status !== 'running') {
    writeJson(response, 200, { ok: true, attempt: attemptView() })
    return
  }
  const authorization = ctx.get('authorization')
  try {
    authorization?.cancel?.(attempt.key)
  } catch {
    // The attempt may already have settled; aborting below is still correct.
  }
  attempt.reject?.(new Error('授权已取消'))
  attempt.controller.abort()
  attempt.status = 'cancelled'
  writeJson(response, 200, { ok: true, attempt: attemptView() })
}

async function handleAuthorizeAnswer(ctx, request, response) {
  if (!admit(ctx, request, response, { mutation: true })) return
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const body = await readJson(request)
  const attempt = AUTHORIZATION_ATTEMPT.current
  if (attempt === null || attempt.pending === null || attempt.pending === undefined) {
    throw new HttpError(409, '当前没有等待回答的授权步骤，请刷新后重试。')
  }
  if (typeof body.id === 'string' && body.id !== '' && body.id !== attempt.pending.id) {
    throw new HttpError(409, '该步骤已被替换，请刷新后重试。')
  }
  const value = typeof body.value === 'string' ? body.value.trim() : ''
  if (value === '') throw new HttpError(400, '请填写内容后再提交。')
  const resolve = attempt.resolve
  attempt.pending = null
  attempt.resolve = null
  attempt.reject = null
  if (typeof resolve === 'function') resolve(value)
  writeJson(response, 200, { ok: true, attempt: attemptView() })
}

// ---------------------------------------------------------------------------
// Agent tools: the bootstrap path for a machine that only received a code
// ---------------------------------------------------------------------------

const INSTALL_URL = 'https://github.com/sldmn233/dsh-profile-share'

const KIND_LABEL = {
  install: '安装',
  enable: '启用',
  disable: '禁用',
  config: '写入配置',
  skip: '跳过',
}

/**
 * Every registered tool must declare how its result is presented; the registry
 * rejects a definition without `output` outright.
 */
const TEXT_OUTPUT = {
  schema: { type: 'string', description: '面向模型的文本结果。' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

/**
 * Fold the per-row requirement list into one entry per distinct credential,
 * naming every row that needs it. Several rows in one bundle often read the
 * same environment variable, and repeating it per row reads as several problems.
 * @param items - Requirement items from `collectRequirements`.
 * @returns One group per distinct requirement, each listing its owning rows.
 */
function groupRequirements(items) {
  const groups = new Map()
  for (const item of items) {
    const key = item.kind === 'env'
      ? `env:${item.envName}`
      : `${item.kind}:${item.entryId}:${item.path}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { item, rows: [item.rowId] })
    else if (!group.rows.includes(item.rowId)) group.rows.push(item.rowId)
  }
  return [...groups.values()]
}

function formatRequirement(group) {
  const rows = group.rows.join('、')
  if (group.item.kind === 'env') {
    const state = group.item.status === 'ready' ? '已设置' : '未设置'
    return `环境变量 ${group.item.envName}（${state}）· 行 ${rows}`
  }
  if (group.item.kind === 'login') return `登录 ${rows}（需到该插件自己的设置页完成）`
  const state = group.item.status === 'ready' ? '已填写' : '未填写'
  return `密钥 ${group.item.path}（${state}）· 行 ${rows}`
}

/**
 * The how-to lines that turn a bare requirement into a next action.
 * @param group - One requirement group.
 * @returns Indented guidance lines, empty when nothing is known.
 */
function guidanceLines(group) {
  const guidance = group.item.guidance
  if (!isRecord(guidance)) return []
  const lines = []
  if (typeof guidance.provider === 'string' && typeof guidance.applyUrl === 'string') {
    lines.push(`  ↳ 申请：${guidance.provider} ${guidance.applyUrl}`)
  }
  if (typeof guidance.note === 'string') lines.push(`  ↳ ${guidance.note}`)
  if (typeof guidance.hint === 'string') lines.push(`  ↳ 字段说明：${guidance.hint}`)
  const commands = Array.isArray(guidance.commands) ? guidance.commands : []
  const command = commands.find((entry) => entry.os === 'windows') ?? commands[0]
  if (command !== undefined && typeof command.command === 'string') lines.push(`  ↳ 写入示例：${command.command}`)
  return lines
}

function formatPlan(payload, plan) {
  const pending = plan.steps.filter((step) => step.status === 'pending')
  const rowCount = payload.bundles.reduce((total, bundle) => total + bundle.rows.length, 0)
  const lines = [
    '[dsh-profile-share] mode=preview',
    `bundles=${payload.bundles.length} rows=${rowCount}`,
  ]
  if (pending.length === 0) {
    lines.push('待执行：无（当前 profile 已经与分享码一致）')
    return lines.join('\n')
  }
  lines.push(`待执行：安装 ${plan.summary.install} 个 · 插件开关 ${plan.summary.bundleToggle} 项 · 写入配置 ${plan.summary.config} 项`)
  for (const step of pending) lines.push(`- ${KIND_LABEL[step.kind] ?? step.kind} ${step.target}（${step.detail}）`)
  lines.push('把这段计划给用户确认后，用同样的 code 加 apply=true 再调用一次。')
  return lines.join('\n')
}

async function formatApplyOutcome(ctx, outcome) {
  const lines = [
    '[dsh-profile-share] mode=apply',
    `changed=${outcome.changed} restartRequired=${outcome.restartRequired}`,
  ]
  for (const result of outcome.results) {
    if (result.status === 'skipped') continue
    lines.push(`[${result.status}] ${KIND_LABEL[result.kind] ?? result.kind} ${result.target}${result.error === undefined ? '' : `：${result.error}`}`)
  }
  if (outcome.changed === 0) lines.push('没有产生变更（当前 profile 已与分享码一致）。')
  if (outcome.restartRequired) lines.push('部分插件需要重启 DSH 才会生效。')
  const items = await collectRequirements(ctx)
  const missing = items.filter((item) => item.status !== 'ready')
  if (missing.length === 0) {
    lines.push('凭据检查：没有待补齐的项。')
    return lines.join('\n')
  }
  const groups = groupRequirements(missing)
  lines.push(`还有 ${groups.length} 项凭据待补齐（设置 → 分享与同步 → 首次配置 可直接填写）：`)
  for (const group of groups) {
    lines.push(`- ${formatRequirement(group)}`)
    lines.push(...guidanceLines(group))
  }
  return lines.join('\n')
}

/**
 * Import tool. Preview by default so the agent can show the plan and get the
 * user's confirmation before anything is installed or written.
 * @param ctx - Cordis context owning the services.
 * @returns Tool definition.
 */
function createImportTool(ctx) {
  return {
    name: 'profile_share_import',
    description: [
      '导入一条 DSH 分享码（以 DSH-SHARE/1: 开头），把对方的插件选择、启用状态与配置覆盖复刻到当前 profile。',
      'apply 省略或 false 时只返回计划（要安装/启用的插件、要写入的配置），供你向用户确认；apply=true 才真正执行。',
      `当前 DSH 若还未安装本插件，先用 plugin_manager 安装 ${INSTALL_URL} 再调用。`,
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '完整分享码，包含 DSH-SHARE/1: 前缀。' },
        apply: { type: 'boolean', description: 'true 才执行；省略或 false 只预览计划。' },
        fullAlign: {
          type: 'boolean',
          description: 'true 时同时禁用当前 profile 有、但分享码里没有的 profile 插件。',
        },
      },
      required: ['code'],
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const code = isRecord(args) && typeof args.code === 'string' ? args.code : ''
      let payload
      try {
        payload = decodeCode(code)
      } catch (error) {
        return `[dsh-profile-share] 分享码无法解析：${error instanceof Error ? error.message : String(error)}`
      }
      const fullAlign = isRecord(args) && args.fullAlign === true
      if (!isRecord(args) || args.apply !== true) {
        return formatPlan(payload, await buildPlan(ctx, payload, fullAlign))
      }
      return await formatApplyOutcome(ctx, await runApply(ctx, payload, fullAlign))
    },
  }
}

/**
 * Requirement listing tool, used to walk the user through first-run setup.
 * @param ctx - Cordis context owning the services.
 * @returns Tool definition.
 */
function createRequirementsTool(ctx) {
  return {
    name: 'profile_share_requirements',
    description: '列出当前 profile 仍缺的凭据：配置里的密钥、未设置的环境变量、需要手动完成的登录态。分享码导入后用它引导用户补齐。',
    parameters: { type: 'object', properties: {} },
    output: TEXT_OUTPUT,
    execute: async () => {
      const items = await collectRequirements(ctx)
      const missing = items.filter((item) => item.status !== 'ready')
      const groups = groupRequirements(missing)
      const lines = [`[dsh-profile-share] 检出 ${items.length} 项，其中待补齐 ${groups.length} 项`]
      for (const group of groups) {
        lines.push(`- ${formatRequirement(group)}`)
        lines.push(...guidanceLines(group))
      }
      if (groups.length === 0) lines.push('没有待补齐的项。')
      const flows = readFlows(ctx)
      if (flows.length > 0) {
        const wanted = groups.map((group) => group.item.authorize).filter((key) => typeof key === 'string' && key !== '')
        const relevant = flows.filter((flow) => wanted.includes(flow.key))
        lines.push(`另有 ${flows.length} 个可一键授权入口（页面「首次配置」里有按钮）`)
        if (relevant.length > 0) {
          lines.push('与本页待补齐项直接对应的：')
          for (const flow of relevant) lines.push(`- ${flow.label}（key=${flow.key}）`)
        }
        lines.push('查看全部：profile_share_authorize action=list')
      }
      return lines.join('\n')
    },
  }
}

function formatAttempt(mode, attempt) {
  const lines = [`[dsh-profile-share] mode=${mode} key=${attempt.key} status=${attempt.status}`]
  for (const notice of attempt.notices) {
    const url = notice.url === null || notice.url === undefined ? '' : ` → ${notice.url}`
    const code = notice.code === null || notice.code === undefined ? '' : `（码：${notice.code}）`
    lines.push(`- ${notice.message}${url}${code}`)
  }
  const pending = attempt.pending === undefined || attempt.pending === null ? null : attempt.pending
  if (pending !== null) {
    lines.push(`等待输入：${pending.message}`)
    if (pending.kind === 'select') {
      const options = Array.isArray(pending.options) ? pending.options : []
      lines.push(`可选项：${options.map((option) => option.label !== undefined ? option.label : option.id).join(' / ')}`)
      lines.push('把用户的选择用 action=answer value=<选项 id> 提交。')
    } else if (pending.kind === 'secret') {
      lines.push('这是密钥类输入：请让用户在 设置 → 分享与同步 → 首次配置 里填写，不要发到对话里。')
    } else {
      lines.push('把用户的回答用 action=answer value=<回答> 提交。')
    }
  }
  if (attempt.error !== null && attempt.error !== undefined) lines.push(`错误：${attempt.error}`)
  if (attempt.status === 'running' && pending === null) {
    lines.push('流程进行中：把上面带链接的通知交给用户，完成后再查一次 action=status。')
  }
  return lines.join('\n')
}

/**
 * One-click authorization: list what can be authorized, start one, read its
 * state, or cancel it. Same engine as the settings page buttons.
 * @param ctx - Cordis context owning the services.
 * @returns Tool definition.
 */
function createAuthorizeTool(ctx) {
  return {
    name: 'profile_share_authorize',
    description: '列出一键授权入口，或发起/查看/回答/取消一次授权（action=list|start|status|answer|cancel）。发起后返回该流程给出的链接、状态与等待输入的问题；密钥类输入一律不在对话里提交，要引导用户去页面填写。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'start', 'status', 'answer', 'cancel'], description: '要执行的动作。' },
        key: { type: 'string', description: 'start / cancel 时的凭据键，取自 action=list 的结果。' },
        method: { type: 'string', description: '可选：该流程提供的授权方式 id。' },
        value: { type: 'string', description: 'action=answer 时用户的回答；密钥类问题会被拒绝。' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const action = isRecord(args) && typeof args.action === 'string' ? args.action : 'list'
      try {
        if (action === 'list') {
          const flows = readFlows(ctx)
          if (flows.length === 0) return '[dsh-profile-share] 当前 profile 没有注册可一键授权的流程。'
          const lines = [`[dsh-profile-share] 可一键授权 ${flows.length} 个：`]
          for (const flow of flows) {
            const methods = flow.methods.map((method) => method.label || method.id).join(' / ')
            const suffix = methods === '' ? '' : `，方式：${methods}`
            lines.push(`- ${flow.label}（key=${flow.key}${suffix}${flow.inFlight ? '，进行中' : ''}）`)
          }
          return lines.join('\n')
        }
        if (action === 'start') {
          const attempt = await beginAuthorization(
            ctx,
            isRecord(args) ? args.key : undefined,
            isRecord(args) ? args.method : undefined,
          )
          return formatAttempt('started', attempt)
        }
        if (action === 'cancel') {
          const attempt = AUTHORIZATION_ATTEMPT.current
          if (attempt === null) return '[dsh-profile-share] 当前没有进行中的授权。'
          try {
            ctx.get('authorization')?.cancel?.(attempt.key)
          } catch {
            // Already settled; the abort below still ends the attempt.
          }
          attempt.reject?.(new Error('授权已取消'))
          attempt.controller.abort()
          attempt.status = 'cancelled'
          return '[dsh-profile-share] 已取消当前授权。'
        }
        if (action === 'answer') {
          const attempt = AUTHORIZATION_ATTEMPT.current
          const pending = attempt === null ? null : attempt.pending
          if (pending === null || pending === undefined) return '[dsh-profile-share] 当前没有等待回答的授权步骤。'
          if (pending.kind === 'secret') {
            return '[dsh-profile-share] 这是密钥类输入，请不要在对话里发送；请让用户在 设置 → 分享与同步 → 首次配置 里填写。'
          }
          const value = isRecord(args) && typeof args.value === 'string' ? args.value.trim() : ''
          if (value === '') return '[dsh-profile-share] 缺少 value。'
          const resolve = attempt.resolve
          attempt.pending = null
          attempt.resolve = null
          attempt.reject = null
          if (typeof resolve === 'function') resolve(value)
          return '[dsh-profile-share] 已提交，等待流程继续；用 action=status 查看结果。'
        }
        const attempt = attemptView()
        return attempt === null ? '[dsh-profile-share] 当前没有进行中的授权。' : formatAttempt('status', attempt)
      } catch (error) {
        return `[dsh-profile-share] ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}
