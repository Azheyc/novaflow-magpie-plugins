import { timingSafeEqual } from "node:crypto"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

const IMAGE_PATHS = new Set([
  "/images/generations",
  "/images/edits",
])

function sameToken(left, right) {
  const a = Buffer.from(String(left ?? ""))
  const b = Buffer.from(String(right ?? ""))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function bearer(value) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value ?? "").trim())
  return match?.[1] ?? ""
}

function imageModel() {
  return {
    id: "gpt-image-2",
    object: "model",
    created: 0,
    owned_by: "novaflow",
  }
}

export class ImageConnector {
  constructor({
    config,
    accounts,
    session,
    host,
    token,
    fetchImpl = globalThis.fetch,
  }) {
    this.config = config
    this.accounts = accounts
    this.session = session
    this.host = host
    this.token = String(token ?? "")
    this.fetchImpl = fetchImpl
  }

  get baseURL() {
    return `http://${this.config.serviceHost}:${this.config.servicePort}${this.config.imageConnectorPath}`
  }

  get reference() {
    return `${this.config.imageProviderId}/${this.config.imageModelId}`
  }

  route() {
    if (this.session.projection().status !== "authenticated") return null
    return this.accounts.resolve(this.config.imageModelId)
  }

  authorized(request) {
    return sameToken(bearer(request.headers.authorization), this.token)
  }

  async ensureProvider() {
    const route = this.route()
    if (!route) throw new Error("尚未同步到 NovaFlow 的 gpt-image-2，请刷新 NovaFlow 供应商模型后重试")
    if (!this.token) throw new Error("NovaFlow 生图连接初始化失败，请重试")
    await this.host.ensureImageProvider({
      id: this.config.imageProviderId,
      name: this.config.imageProviderName,
      baseURL: this.baseURL,
      token: this.token,
      model: this.config.imageModelId,
    })
    return this.reference
  }

  async handle(request, response) {
    const url = new URL(request.url, this.baseURL)
    const prefix = this.config.imageConnectorPath
    if (!url.pathname.startsWith(prefix)) return false
    if (!this.authorized(request)) {
      response.statusCode = 401
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({ error: { message: "NovaFlow image connector is not authorized" } }))
      return true
    }
    const suffix = url.pathname.slice(prefix.length) || "/"
    if (request.method === "GET" && suffix === "/models") {
      if (!this.route()) {
        response.statusCode = 401
        response.setHeader("content-type", "application/json; charset=utf-8")
        response.end(JSON.stringify({ error: { message: "NovaFlow is signed out or has no authorized image model" } }))
        return true
      }
      response.statusCode = 200
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({ object: "list", data: [imageModel()] }))
      return true
    }
    if (request.method !== "POST" || !IMAGE_PATHS.has(suffix)) {
      response.statusCode = 404
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({ error: { message: "Unknown NovaFlow image connector path" } }))
      return true
    }
    const route = this.route()
    if (!route) {
      response.statusCode = 401
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({ error: { message: "NovaFlow is signed out or has no authorized image model" } }))
      return true
    }

    const target = new URL("/v1" + suffix, this.config.origin)
    const headers = new Headers()
    for (const name of ["accept", "content-type"]) {
      const value = request.headers[name]
      if (typeof value === "string" && value) headers.set(name, value)
    }
    headers.set("authorization", `Bearer ${route.key.key}`)
    const abort = new AbortController()
    request.once("aborted", () => abort.abort())
    response.once("close", () => {
      if (!response.writableEnded) abort.abort()
    })
    let upstream
    try {
      upstream = await this.fetchImpl(target, {
        method: "POST",
        headers,
        body: Readable.toWeb(request),
        duplex: "half",
        redirect: "error",
        signal: abort.signal,
      })
    } catch (error) {
      if (!response.headersSent) {
        response.statusCode = abort.signal.aborted ? 499 : 502
        response.setHeader("content-type", "application/json; charset=utf-8")
        response.end(JSON.stringify({
          error: {
            message: abort.signal.aborted ? "NovaFlow image request was cancelled" : "NovaFlow image request failed",
          },
        }))
      }
      return true
    }
    response.statusCode = upstream.status
    for (const name of ["content-type", "content-length", "content-disposition", "cache-control", "x-request-id"]) {
      const value = upstream.headers.get(name)
      if (value) response.setHeader(name, value)
    }
    if (!upstream.body) {
      response.end()
      return true
    }
    try {
      await pipeline(Readable.fromWeb(upstream.body), response)
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) response.destroy(error)
    }
    return true
  }
}
