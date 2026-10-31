const PLUGIN_PREFIX = "/api/novaflow/v1/plugin"
export class ApiError extends Error {
  constructor(message, { status = 0, code = "", requestId = "", cause = undefined } = {}) {
    super(message, { cause })
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

function joinPath(base, path) {
  return String(base ?? "").replace(/\/+$/, "") + "/" + String(path ?? "").replace(/^\/+/, "")
}

function requestIdOf(metadata) {
  return typeof metadata?.request_id === "string" ? metadata.request_id : ""
}

function errorMessage(payload, status) {
  const fields = { display_name: "技能名称不能超过160字", description: "用途说明不能超过2000字", slug: "技能标识无效，请更新插件后重试", idempotency_key: "分享请求标识无效，请重新打开分享窗口", expected_version: "技能版本已变化，请刷新后重试", package: "请选择根目录包含 SKILL.md 的 ZIP 包" }
  const reason = payload?.reason || payload?.code
  if (reason === "SKILL_PACKAGE_INVALID" && Object.hasOwn(fields, payload?.metadata?.field)) return fields[payload.metadata.field]
  if (reason === "SKILL_CATEGORY_INVALID" || reason === "SKILL_CATEGORY_NOT_FOUND") return "公司分类已变化，请刷新技能商店后重新选择分类"
  return typeof payload?.message === "string" && payload.message ? payload.message : `NovaFlow returned HTTP ${status}`
}

async function limitedBytes(response, limit) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {})
    throw new ApiError("NovaFlow response exceeds the size limit", { status: response.status, code: "RESPONSE_TOO_LARGE" })
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new ApiError("NovaFlow response exceeds the size limit", { status: response.status, code: "RESPONSE_TOO_LARGE" })
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export class ApiClient {
  constructor(config, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")
    this.config = config
    this.fetchImpl = fetchImpl
    this.now = now
  }

  async request(path, {
    method = "GET",
    accessToken = "",
    body,
    headers = {},
    signal,
    timeoutMs = this.config.requestTimeoutMs,
    expect = "json",
  } = {}) {
    if (!path.startsWith("/")) throw new Error("API path must be absolute under the fixed origin")
    const allowed = path.startsWith(PLUGIN_PREFIX)
    if (!allowed) throw new Error("API path is outside NovaFlow's plugin contract")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("NovaFlow request timed out")), timeoutMs)
    const abort = () => controller.abort(signal.reason)
    signal?.addEventListener("abort", abort, { once: true })
    try {
      const requestHeaders = new Headers({ accept: expect === "binary" ? "*/*" : "application/json" })
      new Headers(headers).forEach((value, name) => requestHeaders.set(name, value))
      if (accessToken) requestHeaders.set("authorization", `Bearer ${accessToken}`)
      let requestBody = body
      if (body !== undefined && !(body instanceof FormData) && !(body instanceof Uint8Array) && typeof body !== "string") {
        requestHeaders.set("content-type", "application/json")
        requestBody = JSON.stringify(body)
      }
      const target = new URL(path, this.config.origin)
      if (
        target.origin !== this.config.origin
        || !target.pathname.startsWith(PLUGIN_PREFIX)
      ) {
        throw new Error("API path normalized outside NovaFlow's plugin contract")
      }
      const response = await this.fetchImpl(target.href, {
        method,
        headers: requestHeaders,
        body: requestBody,
        redirect: "error",
        signal: controller.signal,
      })
      if (response.status === 304) return { notModified: true, response }
      if (!response.ok) {
        let payload
        try {
          payload = JSON.parse(new TextDecoder().decode(await limitedBytes(response, 128 << 10)))
        } catch {}
        const error = new ApiError(
          errorMessage(payload, response.status),
          {
            status: response.status,
            code: typeof payload?.reason === "string" ? payload.reason : typeof payload?.code === "string" ? payload.code : "",
            requestId: requestIdOf(payload?.metadata),
          },
        )
        throw error
      }
      if (expect === "binary") return { bytes: new Uint8Array(await limitedBytes(response, this.config.maxSkillBytes)), response }
      const bytes = await limitedBytes(response, this.config.maxResponseBytes)
      let payload
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes))
      } catch (cause) {
        throw new ApiError("NovaFlow returned invalid JSON", { status: response.status, code: "INVALID_JSON", cause })
      }
      if (payload && typeof payload === "object" && Object.hasOwn(payload, "code") && Object.hasOwn(payload, "data")) {
        if (payload.code !== 0) {
          throw new ApiError(payload.message || "NovaFlow request failed", {
            status: response.status,
            code: typeof payload.reason === "string" ? payload.reason : String(payload.code),
            requestId: requestIdOf(payload.metadata),
          })
        }
        return payload.data
      }
      return payload
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (controller.signal.aborted) throw new ApiError("NovaFlow request failed or timed out", { code: "NETWORK_TIMEOUT", cause: error })
      throw new ApiError("NovaFlow request failed", { code: "NETWORK", cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }

  async validateConnectionKey(accessToken) {
    return this.bootstrap(accessToken)
  }

  async refresh(connectionKey) {
    await this.bootstrap(connectionKey)
    return {
      access_token: connectionKey,
      refresh_token: connectionKey,
      expires_in: 365 * 24 * 60 * 60,
    }
  }

  async logout(accessToken) {
    return this.request(`${PLUGIN_PREFIX}/auth/revoke`, {
      method: "POST",
      accessToken,
    })
  }

  async bootstrap(accessToken, signal) {
    return this.request(`${PLUGIN_PREFIX}/bootstrap`, { accessToken, signal })
  }

  async credentialsBatch(accessToken, keyIds, expectedRevision, signal) {
    return this.request(`${PLUGIN_PREFIX}/credentials/batch`, {
      method: "POST",
      accessToken,
      body: { key_ids: keyIds, expected_revision: expectedRevision },
      signal,
    })
  }

  async sync(accessToken, revision = "", signal) {
    const path = revision
      ? `${PLUGIN_PREFIX}/sync?if_none_match=${encodeURIComponent(revision)}`
      : `${PLUGIN_PREFIX}/sync`
    return this.request(path, { accessToken, signal })
  }

  async usage(accessToken, signal) {
    return this.request(`${PLUGIN_PREFIX}/usage`, { accessToken, signal })
  }

  async config(accessToken, revision = "", signal) {
    const path = revision
      ? `${PLUGIN_PREFIX}/config?if_none_match=${encodeURIComponent(revision)}`
      : `${PLUGIN_PREFIX}/config`
    return this.request(path, { accessToken, signal })
  }

  async saveConfig(accessToken, payload, expectedRevision, signal) {
    return this.request(`${PLUGIN_PREFIX}/config`, {
      method: "PUT",
      accessToken,
      body: { expected_revision: expectedRevision, payload },
      signal,
    })
  }

  async skills(accessToken, cursor = "", signal) {
    const query = new URLSearchParams({ limit: "50" })
    if (cursor) query.set("cursor", cursor)
    return this.request(`${PLUGIN_PREFIX}/skills?${query}`, { accessToken, signal })
  }

  async skillStore(accessToken, signal) {
    return this.request(`${PLUGIN_PREFIX}/skills/store`, { accessToken, signal })
  }

  async skillStoreDetail(accessToken, sourceKind, skillId, signal) {
    return this.request(
      `${PLUGIN_PREFIX}/skills/store/${encodeURIComponent(sourceKind)}/${encodeURIComponent(skillId)}`,
      { accessToken, signal },
    )
  }

  async downloadSkillStoreVersion(accessToken, sourceKind, skillId, version, signal) {
    return this.request(
      `${PLUGIN_PREFIX}/skills/store/${encodeURIComponent(sourceKind)}/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/download`,
      {
        accessToken,
        signal,
        expect: "binary",
      },
    )
  }

  async skill(accessToken, skillId, signal) {
    return this.request(`${PLUGIN_PREFIX}/skills/${encodeURIComponent(skillId)}`, { accessToken, signal })
  }

  async downloadSkill(accessToken, skillId, version, signal) {
    return this.request(`${PLUGIN_PREFIX}/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}/download`, {
      accessToken,
      signal,
      expect: "binary",
    })
  }

  async contributeSkill(accessToken, form, signal) {
    return this.request(`${PLUGIN_PREFIX}/skills/contributions`, {
      method: "POST",
      accessToken,
      body: form,
      signal,
      timeoutMs: 60_000,
    })
  }

  async updateSkill(accessToken, skillId, form, signal) {
    return this.request(`${PLUGIN_PREFIX}/skills/${encodeURIComponent(skillId)}/versions`, {
      method: "POST",
      accessToken,
      body: form,
      signal,
      timeoutMs: 60_000,
    })
  }

  async receipt(accessToken, receipt, signal) {
    return this.request(`${PLUGIN_PREFIX}/sync-receipts`, {
      method: "POST",
      accessToken,
      body: receipt,
      signal,
    })
  }

}
