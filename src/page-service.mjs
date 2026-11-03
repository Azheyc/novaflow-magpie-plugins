import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomId } from "./state-store.mjs"
import { ALIAS_RE } from "./host-adapter.mjs"

const ROOT = fileURLToPath(new URL("../page/", import.meta.url))
// Wails uses a custom scheme on macOS/Linux and an intercepted HTTP origin
// in Windows WebView2. Keep these exact: *.localhost is not a trusted host.
const MAGPIE_DESKTOP_ORIGINS = new Set([
  "wails://localhost",
  "http://wails.localhost",
])
const BODY_LIMIT = 1 << 20
const STATIC = new Map([
  ["/", ["service.html", "text/html; charset=utf-8"]],
  ["/request.js", ["request.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["/store-model.mjs", ["store-model.mjs", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/magpie-components.css", ["magpie-components.css", "text/css; charset=utf-8"]],
  ["/logo.png", ["logo.png", "image/png"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
])

function securityHeaders(response, port) {
  // Stock Magpie proxies this page under its own loopback port. The
  // opaque sandbox cannot use self as a source; allow loopback origins.
  const serviceSource = "http://127.0.0.1:* http://localhost:*"
  response.setHeader("content-security-policy", [
    `default-src ${serviceSource}`,
    `script-src ${serviceSource}`,
    `style-src ${serviceSource}`,
    `img-src ${serviceSource} data:`,
    `connect-src ${serviceSource}`,
    // The page replaces its sandboxed frame; its ancestor is the Magpie
    // window. Name both desktop origins, including Windows WebView2.
    `frame-ancestors 'self' ${[...MAGPIE_DESKTOP_ORIGINS].join(" ")} ${serviceSource}`,
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "))
  response.setHeader("referrer-policy", "no-referrer")
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("cache-control", "no-store")
}

function json(response, status, body) {
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.end(JSON.stringify(body))
}

function sameHost(header, port) {
  if (!header) return false
  return header === `127.0.0.1:${port}` || header === `localhost:${port}`
}

async function readJson(request) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 })
  }
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.byteLength
    if (size > BODY_LIMIT) throw Object.assign(new Error("Request body is too large"), { status: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { status: 400 })
  }
}

function allowedOrigin(request, port) {
  const origin = request.headers.origin
  if (!origin) return true
  if (origin === "null") return true
  if (MAGPIE_DESKTOP_ORIGINS.has(origin)) return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

function noSecretProjection(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^(?:key|access|refresh|access_token|refresh_token|token|secret|password)$/i.test(key)) return undefined
    return item
  }))
}

export function createPageServer({
  config,
  control,
  session,
  sync,
  accounts,
  skills,
  skillManager,
  api,
  host,
  defaults,
  preferencesStore,
  hostVersion = config.hostMinVersion,
  port = config.servicePort,
  hostName = config.serviceHost,
}) {
  const csrfToken = randomId(32)
  let actualPort = port
  const diagnostics = { lastError: "", commandCount: 0 }

  const server = createServer(async (request, response) => {
    securityHeaders(response, actualPort)
    if (!sameHost(request.headers.host, actualPort)) {
      json(response, 421, { error: "Invalid loopback Host" })
      return
    }
    // Magpie serves plugin pages under `Content-Security-Policy: sandbox`, so
    // every request from that page — the frame navigation, app.css/app.js and
    // the typed API calls — arrives as an opaque origin with
    // `Sec-Fetch-Site: cross-site`. Sec-Fetch-Site therefore cannot separate
    // the Magpie page from a website. What still does: the Host is pinned to
    // this loopback port (DNS rebinding), HTML never grants cross-origin read
    // access, and every API request needs the per-process page token.
    if (!allowedOrigin(request, actualPort)) {
      console.error(
        "novaflow-magpie-plugins: rejected service request",
        request.method,
        request.url,
        "origin=" + String(request.headers.origin || "-"),
      )
      json(response, 403, { error: "Loopback service accepts only its Magpie page" })
      return
    }
    const url = new URL(request.url, `http://${hostName}:${actualPort}`)
    // Only token-protected API responses need CORS in the opaque sandbox.
    // Granting Origin:null access to HTML would let ANY website's sandbox
    // fetch the embedded command token. Frame navigation and classic static
    // scripts/styles do not need that grant.
    if (url.pathname.startsWith("/api/") && (request.headers.origin === "null" || MAGPIE_DESKTOP_ORIGINS.has(request.headers.origin))) {
      response.setHeader("access-control-allow-origin", request.headers.origin)
      response.setHeader("vary", "Origin")
      if (request.method === "OPTIONS") {
        response.statusCode = 204
        response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
        response.setHeader("access-control-allow-headers", "content-type,x-novaflow-page-token")
        response.setHeader("access-control-max-age", "600")
        response.end()
        return
      }
    }
    try {
      if (request.method === "GET" && STATIC.has(url.pathname)) {
        const [file, type] = STATIC.get(url.pathname)
        let body = await readFile(join(ROOT, file))
        if (file === "service.html") {
          body = body.toString("utf8")
            .replace("__CSRF_TOKEN__", csrfToken)
            .replace("__NOVAFLOW_ORIGIN__", config.origin)
        }
        response.setHeader("content-type", type)
        response.end(body)
        return
      }
      if (url.pathname.startsWith("/api/")) {
        if (request.headers["x-novaflow-page-token"] !== csrfToken) {
          json(response, 403, { error: "Missing page command token", code: "PAGE_TOKEN_INVALID" })
          return
        }
        diagnostics.commandCount++
        const state = () => {
          const identity = session.projection()
          const skillState = skills.projection()
          if (identity.accountMode !== "enterprise" || !identity.capabilities?.company_skills) {
            skillState.catalog = []
            skillState.store = null
            skillState.entries = []
            skillState.count = 0
          }
          return noSecretProjection({
            service: {
              origin: config.origin,
              loopbackPort: actualPort,
              pluginVersion: config.pluginVersion,
              hostVersion,
              hostMinVersion: config.hostMinVersion,
              compatible: true,
            },
            session: session.projection(),
            sync: { ...sync.projection(), skills: skillState },
            accounts: accounts.projection(),
            skills: skillState,
            defaults: defaults.status(),
            preferences: {},
            hostLibrary: {
              available: host.available,
              version: host.version,
              source: "magpie-cli",
              error: host.lastError,
            },
            diagnostics: {
              requestCode: sync.projection().errorCode,
              requestId: sync.projection().requestId,
              commands: diagnostics.commandCount,
            },
          })
        }
        if (request.method === "GET" && url.pathname === "/api/state") {
          json(response, 200, control ? noSecretProjection(await control.command({ operation: "status" })) : state())
          return
        }
        if (request.method === "POST" && url.pathname === "/api/command" && control) {
          const body = await readJson(request)
          const result = await control.command({ operation: String(body.operation || ""), payload: body.payload || {} })
          json(response, 200, noSecretProjection(result))
          return
        }
        if (request.method === "POST" && url.pathname === "/api/open-website") {
          await readJson(request)
          await host.openWebsite()
          json(response, 200, { opened: true })
          return
        }
        if (request.method === "GET" && url.pathname === "/api/local-skills") {
          if (session.projection().accountMode !== "enterprise" || !session.projection().capabilities?.company_skills) {
            json(response, 403, { error: "企业用户才可使用技能功能" })
            return
          }
          json(response, 200, await host.listSkills())
          return
        }
        if (request.method === "GET" && url.pathname === "/api/agents") {
          if (session.projection().accountMode !== "enterprise" || !session.projection().capabilities?.company_skills) { json(response, 403, { error: "企业用户才可使用技能功能" }); return }
          json(response, 200, { agents: await host.listAgents() })
          return
        }
        if (request.method === "POST" && url.pathname === "/api/sync") {
          await readJson(request)
          await sync.syncNow("page")
          json(response, 200, state())
          return
        }
        if (request.method === "POST" && url.pathname === "/api/logout") {
          await readJson(request)
          json(response, 200, await control.command({ operation: "logout" }))
          return
        }
        if (request.method === "POST" && url.pathname === "/api/preferences") {
          await readJson(request)
          json(response, 410, { error: "本机技能关联设置已移除", code: "PLUGIN_PREFERENCES_RETIRED" })
          return
        }
        if (request.method === "POST" && url.pathname === "/api/config") {
          await readJson(request)
          json(response, 410, { error: "Company recommendation configuration has been retired", code: "PLUGIN_CONFIG_RETIRED" })
          return
        }
        if (request.method === "POST" && url.pathname === "/api/skills/share") {
          if (session.projection().accountMode !== "enterprise" || !session.projection().capabilities?.contribute_skills) {
            json(response, 403, { error: "This account cannot contribute company skills" })
            return
          }
          const body = await readJson(request)
          const result = await skillManager.share({
            sourceName: String(body.sourceName ?? ""),
            display_name: String(body.display_name ?? body.displayName ?? ""),
            description: body.description === undefined ? undefined : String(body.description),
            category_id: String(body.category_id ?? ""),
            updateSkillId: body.updateSkillId ? String(body.updateSkillId) : "",
            expectedVersion: Number(body.expectedVersion ?? 0),
            idempotencyKey: String(body.idempotencyKey ?? ""),
          })
          json(response, 200, { result, state: state() })
          return
        }
        if (request.method === "POST" && url.pathname === "/api/skills/remove") {
          if (session.projection().accountMode !== "enterprise" || !session.projection().capabilities?.company_skills) { json(response, 403, { error: "企业用户才可使用技能功能" }); return }
          const body = await readJson(request)
          const entry = skills.registry[String(body.skillId ?? "")]
          if (!entry || !ALIAS_RE.test(entry.alias)) throw new Error("Managed skill was not found")
          const removed = await host.removeSkill(entry.alias)
          entry.registration = removed.registered ? "failed" : "removed"
          skills.persist()
          json(response, 200, state())
          return
        }
        json(response, 404, { error: "Unknown typed command" })
        return
      }
      json(response, 404, { error: "Not found" })
    } catch (error) {
      diagnostics.lastError = String(error?.code || "PAGE_COMMAND_FAILED")
      json(response, Number(error?.status) || 400, {
        error: String(error?.message ?? "Page command failed").slice(0, 300),
        code: String(error?.code ?? "PAGE_COMMAND_FAILED"),
        requestId: String(error?.requestId ?? ""),
      })
    }
  })

  server.on("listening", () => {
    const address = server.address()
    if (address && typeof address === "object") actualPort = address.port
  })

  return {
    server,
    get port() {
      return actualPort
    },
    async start() {
      if (server.listening) return
      // A restarted Magpie can still be draining the previous host for a
      // moment; wait briefly for the fixed port instead of failing the whole
      // page for the rest of the session.
      const deadline = Date.now() + 15_000
      for (;;) {
        try {
          await new Promise((resolve, reject) => {
            const onError = (error) => {
              server.off("listening", onListening)
              reject(error)
            }
            const onListening = () => {
              server.off("error", onError)
              resolve()
            }
            server.once("error", onError)
            server.once("listening", onListening)
            server.listen(port, hostName)
          })
          return
        } catch (error) {
          const busy = error?.code === "EADDRINUSE" || /in use/i.test(String(error?.message || ""))
          if (!busy || Date.now() >= deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    },
    async stop() {
      if (!server.listening) return
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export { noSecretProjection }
