import { AccountManager, modelRoute, routeId } from "./accounts.mjs"
import {
  PRODUCTION_ORIGIN,
  PRODUCTION_ORIGIN_ALIASES,
  assertSupportedHost,
  compareVersions,
} from "./config.mjs"
import { NativeAccountAuth } from "./native-auth.mjs"

const CHAT = "@ai-sdk/openai-compatible"
const MESSAGES = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"
const GEMINI = "@ai-sdk/google"
const PROTOCOLS = { anthropic: MESSAGES, responses: RESPONSES, "chat-completions": CHAT, gemini: GEMINI }
const PATHS = { anthropic: "/v1", responses: "/v1", "chat-completions": "/v1", gemini: "/v1beta" }
const RESERVED_HEADERS = new Set([
  "authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "host",
  "content-length", "connection", "transfer-encoding", "upgrade", "keep-alive", "te", "trailer",
])

function protocolOf(value) {
  const aliases = {
    openai: "responses",
    "openai-compatible": "chat-completions",
    google: "gemini",
    messages: "anthropic",
  }
  const protocol = String(value ?? "auto").trim().toLowerCase()
  return aliases[protocol] ?? protocol
}

function modelProtocol(model) {
  const explicit = protocolOf(model?.protocol)
  if (Object.hasOwn(PROTOCOLS, explicit)) return explicit
  const id = String(model?.upstream_model_id ?? model?.id ?? "").toLowerCase().split("/").at(-1)
  if (/^claude[-.]/.test(id)) return "anthropic"
  if (/^(gpt-|o\d|codex-|chatgpt-)/.test(id)) return "responses"
  if (/^gemini[-.]/.test(id)) return "gemini"
  return "chat-completions"
}

function cleanHeaders(value) {
  if (value === undefined || value === "") return {}
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error("Request headers must be a JSON object")
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request headers must be a JSON object")
  const out = new Headers()
  for (const [name, item] of Object.entries(value)) {
    if (RESERVED_HEADERS.has(name.toLowerCase()) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error("A request header is reserved")
    }
    if (typeof item !== "string" || /[\r\n\0]/.test(item)) throw new Error("Request header values must be strings")
    out.set(name, item)
  }
  return Object.fromEntries(out)
}

function uniqueReasoningLevels(values) {
  const out = []
  for (const value of values.flat(Infinity)) {
    const level = typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? String(value.effort ?? value.value ?? "")
        : ""
    if (level && !out.includes(level)) out.push(level)
  }
  return out
}

function knownReasoningLevels(modelId) {
  const id = String(modelId ?? "").toLowerCase().split("/").at(-1)
  const base = ["low", "medium", "high", "xhigh"]
  if (/^gpt-image/.test(id)) return []
  if (/^gpt-5/.test(id)) {
    if (/^gpt-5\.6-(sol|terra)(?:-|$)/.test(id)) return [...base, "max", "ultra"]
    if (/^gpt-5\.6(?:-|$)/.test(id)) return [...base, "max"]
    return base
  }
  if (/^gpt-6\.1-sol(?:-|$)/.test(id) || /^gpt-6-astra(?:-|$)/.test(id)) return [...base, "max", "ultra"]
  if (/^gpt-6-sol(?:-|$)/.test(id) || /^gpt-6-luna(?:-|$)/.test(id)) return [...base, "max"]
  if (/^gpt-6\.1-terra(?:-|$)/.test(id)) return ["none", ...base]
  return []
}

function reasoningLevelsFromModel(item, modelId) {
  const capabilities = item?.capabilities?.reasoning
  const sources = [
    item?.supported_reasoning_levels,
    item?.reasoning_levels,
    item?.reasoning_options?.filter(option => option?.type === "effort").map(option => option.values),
    capabilities?.effort,
    capabilities?.efforts,
    capabilities?.supported_reasoning_levels,
    item?.reasoning?.effort?.valid,
    item?.reasoning?.effort?.values,
  ]
  const explicit = uniqueReasoningLevels(sources)
  const hasDeclaredLevels = sources.some(value => value !== undefined && value !== null)
  if (hasDeclaredLevels) return explicit
  const known = knownReasoningLevels(modelId)
  return known.length ? known : undefined
}

function invalidRequestBody() {
  return Object.assign(new Error("NovaFlow inference request body is invalid"), {
    code: "INVALID_REQUEST_BODY",
    status: 400,
  })
}

async function readJsonBody(input, init) {
  const body = init?.body
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body)
  }
  if (body instanceof Blob) return body.text()
  if (body !== undefined || !(input instanceof Request) || !input.body || input.bodyUsed) return ""
  return input.clone().text()
}

function operationProtocol(pathname, basePath) {
  const suffix = pathname.startsWith(basePath) ? pathname.slice(basePath.length).replace(/^\/+/, "") : pathname.replace(/^\/+/, "")
  if (/^messages(?:\/|$)/.test(suffix)) return { name: "anthropic", suffix }
  if (/^responses(?:\/|$)/.test(suffix)) return { name: "responses", suffix }
  if (suffix === "chat/completions") return { name: "chat-completions", suffix }
  if (/^models\/.+:(?:generateContent|streamGenerateContent|countTokens)$/.test(suffix)) return { name: "gemini", suffix }
  return { name: "", suffix }
}

function endpointHeaders(protocol, key) {
  const headers = { authorization: `Bearer ${key}` }
  if (protocol === "anthropic") {
    headers["x-api-key"] = key
    headers["anthropic-version"] = "2023-06-01"
  }
  if (protocol === "gemini") headers["x-goog-api-key"] = key
  return headers
}

async function listKeyModels(config, key, signal, fetchImpl = fetch) {
  const declaredBase = new URL(String(key.base_url || config.origin))
  const trustedOrigins = new Set([config.origin])
  if (config.origin === PRODUCTION_ORIGIN) {
    for (const origin of PRODUCTION_ORIGIN_ALIASES) trustedOrigins.add(origin)
  }
  if (!trustedOrigins.has(declaredBase.origin)) {
    throw new Error("Credential base URL does not match the fixed NovaFlow origin")
  }
  // Keep discovery on the canonical origin even when an older NovaFlow
  // backend advertises the controlled apex-domain alias.
  const base = new URL(config.origin)
  const seen = new Set()
  const entries = []
  let path = "/v1/models"
  for (let page = 0; path; page++) {
    if (page >= 100 || seen.has(path)) throw new Error("Invalid or excessive model pagination")
    seen.add(path)
    const response = await fetchImpl(new URL(path, base), {
      headers: { accept: "application/json", authorization: `Bearer ${key.key}` },
      redirect: "error",
      signal,
    })
    if (!response.ok) throw Object.assign(new Error(`NovaFlow model catalog returned HTTP ${response.status}`), { status: response.status })
    const body = await response.json()
    if (!Array.isArray(body?.data)) throw new Error("NovaFlow model catalog is invalid")
    entries.push(...body.data)
    if (typeof body.next === "string" && body.next) {
      const next = new URL(body.next, base)
      if (!trustedOrigins.has(next.origin) || next.pathname !== "/v1/models") throw new Error("Model pagination left the fixed origin")
      path = "/v1/models" + next.search
    } else if (body.has_more === true) {
      const last = body.last_id ?? body.data.at(-1)?.id
      if (!last) throw new Error("Model pagination cursor is missing")
      path = "/v1/models?after_id=" + encodeURIComponent(last)
    } else path = ""
  }
  return entries
    .filter((item) => typeof (item?.id ?? item?.upstream_model_id) === "string" && (item?.id ?? item?.upstream_model_id))
    .map((item) => ({
      upstream_model_id: item.upstream_model_id ?? item.id,
      display_name: String(item.display_name ?? item.name ?? item.upstream_model_id ?? item.id),
      protocol: modelProtocol(item),
      context_window: Number(item.context_window ?? item.context_length ?? 0),
      max_output_tokens: Number(item.max_output_tokens ?? item.max_completion_tokens ?? 0),
      reasoning: item.reasoning === true || item.capabilities?.reasoning === true,
      reasoning_levels: reasoningLevelsFromModel(item, item.upstream_model_id ?? item.id),
      service_tiers: Array.isArray(item.service_tiers) ? item.service_tiers : Array.isArray(item.serviceTiers) ? item.serviceTiers : [],
      capabilities: {
        imageGeneration: /^gpt-image-2$/.test(String(item.upstream_model_id ?? item.id)),
        vision: item.capabilities?.vision === true || item.capabilities?.input?.image === true,
        tools: item.capabilities?.tools !== false,
      },
      release_date: item.release_date ?? "",
    }))
}

function usageConversion(value) {
  if (!value || typeof value !== "object") return { error: "NovaFlow usage is unavailable", windows: [] }
  const mode = value.account_mode
  if (mode !== "personal" && mode !== "enterprise") return { error: "NovaFlow identity mode is unavailable", windows: [] }
  const unit = typeof value.unit === "string" && value.unit ? value.unit : ""
  const amount = (number) => {
    const text = number === null || number === undefined ? "unknown" : String(number)
    return text === "unknown" ? text : `${text}${unit ? " " + unit : " (unit unknown)"}`
  }
  const windows = []
  if (value.limits) {
    for (const [name, period] of [["Daily", "daily"], ["Monthly", "monthly"]]) {
      if (value.limits[`${period}_mode`] !== "limited") continue
      const limit = Number(value.limits[`${period}_limit`])
      const used = Number(value.limits[`${period}_used`])
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
        windows.push({
          name,
          used: Math.max(0, (used / limit) * 100),
          display: `${amount(value.limits[`${period}_used`])} / ${amount(value.limits[`${period}_limit`])}`,
          aside: false,
        })
      }
    }
  }
  const wallet = mode === "enterprise" ? value.company : value.personal
  return {
    plan: mode === "enterprise" ? "NovaFlow Enterprise" : "NovaFlow Personal",
    user: value.display_name || "",
    balance: amount(wallet?.available),
    windows,
  }
}

export function createNovaFlowProvider({
  client,
  config,
  api,
  session,
  accounts,
  credentials,
  control,
  fetchImpl = fetch,
  hostVersion = config.hostMinVersion,
  report = () => {},
}) {
  assertSupportedHost(hostVersion)
  let loginCatalog = null
  let loginCatalogOwner = ""
  const nativeAuth = new NativeAccountAuth({ api })

  async function activate(getAuth) {
    const auth = await getAuth()
    await session.activateAuth(auth)
    return auth
  }

  async function completeAccess(access) {
    return session.withAccess((token) => Promise.resolve(token)) || access
  }

  async function discoverModels(auth) {
    await session.activateAuth(auth)
    try {
      await credentials.load()
    } catch (error) {
      if (
        error.status === 401
        || error.status === 403
        || error.code === "PLUGIN_COMPANY_INACTIVE"
        || error.code === "PLUGIN_MEMBERSHIP_INACTIVE"
        || error.code === "PLUGIN_SESSION_REVOKED"
      ) {
        session.revoke(error.message)
      }
      throw error
    }
    const output = Object.create(null)
    const failures = []
    const all = []
    for (const row of accounts.rows.values()) {
      const signal = AbortSignal.timeout(config.requestTimeoutMs)
      try {
        const models = await listKeyModels(config, row, signal, fetchImpl)
        accounts.setCatalog(row, models)
        all.push(...models.map((model) => ({ row, model })))
      } catch (error) {
        failures.push({ keyId: String(row.key_id), code: error.status ? `HTTP_${error.status}` : "MODEL_DISCOVERY_FAILED" })
      }
    }
    if (!all.length && failures.length) throw new Error("No authorized NovaFlow key could list models")
    accounts.rebuildRoutes({ imageRouteIds: all.filter(({ model }) => model.capabilities?.imageGeneration).map(({ row, model }) => routeId(row, model.upstream_model_id)) })
    accounts.persist()
    for (const { row, model } of all) {
      const group = String(row.group_name || row.group_id || "")
      const route = modelRoute(row, model, group)
      const publicId = accounts.resolve(route.id)?.publicId
      if (model.capabilities?.imageGeneration && !publicId) continue
      if (publicId) {
        route.id = publicId
        route.api.id = publicId
        if (model.capabilities?.imageGeneration) {
          route.name = model.upstream_model_id + (group ? ` · ${group}` : "")
        }
      }
      route.api.npm = model.capabilities?.imageGeneration ? CHAT : PROTOCOLS[modelProtocol(model)]
      output[route.id] = route
    }
    report("models.ready", { keyCount: accounts.rows.size, routeCount: Object.keys(output).length, failures: failures.length })
    return output
  }

  function takeLoginCatalog() {
    if (!loginCatalog) return null
    const owner = session.ownership?.() ?? ""
    if (owner !== loginCatalogOwner) {
      loginCatalog = null
      loginCatalogOwner = ""
      return null
    }
    const output = structuredClone(loginCatalog)
    loginCatalog = null
    loginCatalogOwner = ""
    return output
  }

  function accountFetch(auth) {
    const configuredHeaders = cleanHeaders(auth?.metadata?.headers)
    return async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input))
      if (requestUrl.origin !== config.origin) throw new Error("Refusing to send credentials outside the fixed NovaFlow origin")
      const op = requestUrl.pathname.startsWith("/v1beta/")
        ? operationProtocol(requestUrl.pathname, "/v1beta")
        : operationProtocol(requestUrl.pathname, "/v1")
      const sourceHeaders = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, name) => sourceHeaders.set(name, value))
      const multipart = op.suffix === "images/edits" && /^multipart\/form-data/i.test(sourceHeaders.get("content-type") || "")
      let form = null, payload
      if (multipart) {
        const raw = init?.body !== undefined ? await new Response(init.body).arrayBuffer() : await input.clone().arrayBuffer()
        form = await new Response(raw, { headers: sourceHeaders }).formData()
        payload = { model: form.get("model") }
      } else {
        const bodyText = await readJsonBody(input, init)
        try {
          payload = JSON.parse(bodyText)
        } catch {
          throw invalidRequestBody()
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidRequestBody()
      }
      const modelId = typeof payload?.model === "string" ? payload.model : ""
      if (!modelId) throw invalidRequestBody()
      const route = accounts.resolve(modelId)
      if (!route) throw new Error("The selected NovaFlow route is no longer authorized; refresh models and sign in again")
      payload.model = route.model.upstream_model_id
      const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const target = new URL(config.origin)
      const path = op.name ? PATHS[op.name] : "/v1"
      target.pathname = path + "/" + op.suffix.replace(/^\/+/, "")
      if (op.name === "gemini") target.searchParams.delete("key")
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
      new Headers(configuredHeaders).forEach((value, name) => {
        if (!headers.has(name)) headers.set(name, value)
      })
      for (const [name, value] of Object.entries(endpointHeaders(op.name, route.key.key))) headers.set(name, value)
      if (form) { form.set("model", payload.model); headers.delete("content-type") }
      headers.delete("content-length")
      headers.delete("x-magpie-agent")
      headers.delete("x-magpie-via")
      const upstreamInit = {
        ...init,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers,
        body: form || JSON.stringify(payload),
        signal: sourceSignal,
        redirect: "error",
      }
      const started = Date.now()
      try {
        const response = await fetchImpl(target, upstreamInit)
        report("inference.response", {
          protocol: op.name || "unknown",
          status: response.status,
          elapsedMs: Date.now() - started,
          key: route.key.stable_account_id,
        })
        return response
      } catch (error) {
        report("inference.failed", { protocol: op.name || "unknown", elapsedMs: Date.now() - started })
        throw error
      }
    }
  }

  const methods = [{
    type: "api",
    label: "使用 NovaFlow 插件连接密钥登录",
    keyless: true,
    async ask(inputs) {
      return nativeAuth.nextPrompt(inputs)
    },
    async authorize(inputs) {
      const result = await nativeAuth.authorize(inputs)
      try {
        const accepted = await session.acceptLogin(result)
        const bootstrap = accepted?.bootstrap ?? {}
        try {
          const discovered = await discoverModels(result)
          if (Object.keys(discovered).length) {
            loginCatalog = structuredClone(discovered)
            loginCatalogOwner = session.ownership?.() ?? ""
          }
        } catch (error) {
          report("models.automatic_login_failed", {
            code: error?.code || "MODEL_DISCOVERY_FAILED",
            status: error?.status || 0,
          })
        }
        const accountId = String(bootstrap.display_name || bootstrap.user_id || "NovaFlow")
        return {
          ...result,
          ...(accountId ? { accountId } : {}),
          ...(bootstrap.user_id ? { uid: String(bootstrap.user_id) } : {}),
          ...(bootstrap.account_mode ? { accountMode: String(bootstrap.account_mode) } : {}),
        }
      } catch (error) {
        nativeAuth.clear()
        throw error
      }
    },
  }]

  const authHook = {
    provider: "novaflow",
    single: true,
    methods,
    ...(control ? { native: control } : {}),
    refreshLead: 5 * 60_000,
    async refresh(auth) {
      await session.activateAuth(auth)
      await session.ensureFresh({ force: true })
      const next = session.internalAuth()
      if (!next) throw Object.assign(new Error("NovaFlow sign-in expired"), { signIn: "expired" })
      return { access: next.access, refresh: next.refresh, expires: next.expiresAt }
    },
    async loader(getAuth) {
      const auth = await activate(getAuth)
      try {
        await session.ensureFresh()
      } catch (error) {
        if (error.signIn) throw error
      }
      return {
        baseURL: config.origin + "/v1",
        apiKey: "",
        headers: {},
        fetch: accountFetch(auth),
      }
    },
    async usage(getAuth) {
      const auth = await activate(getAuth)
      try {
        const owner = session.ownership?.()
        const value = await session.withAccess((access) => api.usage(access))
        const bootstrap = await session.withAccess((access) => api.bootstrap(access))
        session.assertOwnership?.(owner)
        await session.updateBootstrap(bootstrap, { owner })
        return usageConversion({ ...value, display_name: bootstrap.display_name, account_mode: value.account_mode ?? bootstrap.account_mode })
      } catch (error) {
        return { error: String(error?.message ?? error), windows: [], ...(error.signIn ? { signIn: error.signIn } : {}) }
      }
    },
  }

  return {
    auth: authHook,
    provider: {
      id: "novaflow",
      name: "NovaFlow",
      async models(provider, { auth } = {}) {
        await session.activateAuth(auth)
        return takeLoginCatalog() ?? discoverModels(auth)
      },
    },
    "chat.headers": async ({ model }, result) => {
      if (model?.providerID !== "novaflow") return
      result.headers ??= {}
    },
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider.novaflow = { ...(cfg.provider.novaflow ?? {}), name: "NovaFlow" }
    },
  }
}

export { usageConversion, listKeyModels, modelProtocol }
