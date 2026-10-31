import { stableId } from "./state-store.mjs"

function keyId(value) {
  return String(value)
}

function validKey(item) {
  return item
    && item.key_id !== undefined
    && item.key_id !== null
    && item.group_id !== undefined
    && typeof item.key === "string"
    && item.key.length > 0
    && item.status === "active"
}

export function routeId(key, upstreamModelId) {
  const encoded = Buffer.from(String(upstreamModelId), "utf8").toString("base64url")
  return `nf:${keyId(key.key_id)}:${encoded}${upstreamModelId === "gpt-image-2" ? ":gpt-image-2" : ""}`
}

export function decodeRouteId(value) {
  const match = /^nf:([^:]+):([A-Za-z0-9_-]+)(?::(gpt-image-2))?$/.exec(String(value ?? ""))
  if (!match) return null
  try {
    const upstreamModelId = Buffer.from(match[2], "base64url").toString("utf8")
    if (match[3] && upstreamModelId !== match[3]) return null
    return { keyId: match[1], upstreamModelId }
  } catch {
    return null
  }
}

export class AccountManager {
  constructor({ onChange = () => {}, store = null } = {}) {
    this.onChange = onChange
    this.store = store
    this.revision = ""
    this.ownedKeyIds = new Set()
    this.rows = new Map()
    this.routes = new Map()
    this.imageAliases = {}
    this.imageRouteId = ""
    this.rejected = []
    this.updatedAt = ""
    if (store) {
      const saved = store.read()
      this.revision = String(saved.revision ?? "")
      this.ownedKeyIds = new Set(Array.isArray(saved.ownedKeyIds) ? saved.ownedKeyIds.map(String) : [])
      this.rows = new Map((Array.isArray(saved.rows) ? saved.rows : []).map((row) => [keyId(row.key_id), row]))
      this.imageAliases = { ...(saved.imageAliases || {}) }
      this.imageRouteId = String(saved.imageRouteId || "")
      this.rebuildRoutes()
    }
  }

  persist() {
    this.store?.write({
      revision: this.revision,
      ownedKeyIds: [...this.ownedKeyIds],
      rows: [...this.rows.values()],
      imageAliases: this.imageAliases,
      imageRouteId: this.imageRouteId,
      updatedAt: this.updatedAt,
    })
  }

  reconcile(payload, { now = new Date().toISOString() } = {}) {
    const items = Array.isArray(payload?.items) ? payload.items.filter(validKey) : []
    const nextIds = new Set(items.map((item) => keyId(item.key_id)))
    for (const previous of this.ownedKeyIds) {
      if (!nextIds.has(previous)) this.rows.delete(previous)
    }
    this.ownedKeyIds = nextIds
    this.rejected = Array.isArray(payload?.rejected) ? payload.rejected : []
    for (const item of items) {
      const previous = this.rows.get(keyId(item.key_id))
      // Credential snapshots carry authorization metadata, not the vendor's
      // model list. Keep the catalog fetched through provider.models while
      // the key still points at the same upstream group.
      const sameRoute = previous
        && String(previous.group_id) === String(item.group_id)
        && String(previous.base_url ?? "") === String(item.base_url ?? "")
      const models = Array.isArray(item.models)
        ? item.models
        : sameRoute && Array.isArray(previous.models)
          ? previous.models
          : undefined
      this.rows.set(keyId(item.key_id), {
        ...item,
        key_id: item.key_id,
        group_id: item.group_id,
        ...(models ? { models } : {}),
        stable_account_id: `nfk_${stableId("key", item.key_id, item.group_id).slice(0, 24)}`,
      })
    }
    this.revision = String(payload?.revision ?? this.revision)
    this.updatedAt = now
    this.rebuildRoutes()
    this.persist()
    this.onChange()
    return this.projection()
  }

  rebuildRoutes({ imageRouteIds } = {}) {
    this.routes.clear()
    for (const row of this.rows.values()) {
      for (const model of Array.isArray(row.models) ? row.models : []) {
        const id = routeId(row, model.upstream_model_id)
        this.routes.set(id, { key: row, model })
      }
    }
    const eligible = imageRouteIds ? new Set(imageRouteIds) : null
    const images = [...this.routes.entries()].filter(([id, route]) => route.model.upstream_model_id === "gpt-image-2" && (!eligible || eligible.has(id)))
    const previous = images.find(([id]) => id === this.imageRouteId)
    const original = images.find(([id]) => this.imageAliases[id] === "gpt-image-2")
    const selected = previous || original || images.sort((a, b) => String(a[1].key.key_id).localeCompare(String(b[1].key.key_id), "en", { numeric: true }))[0]
    // One visible image model. Keep per-key routes and old suffixed aliases
    // private; changing the catalog may choose a new authorized route, while
    // a request never retries with another key.
    if (selected) {
      this.imageRouteId = selected[0]
      selected[1].publicId = "gpt-image-2"
    }
  }

  setCatalog(key, models) {
    const row = this.rows.get(keyId(key.key_id))
    if (!row) return
    row.models = models.map((model) => ({ ...model, upstream_model_id: String(model.upstream_model_id) }))
    this.rebuildRoutes()
    this.persist()
    this.onChange()
  }

  resolve(modelId) {
    const id = String(modelId)
    const direct = this.routes.get(id)
    if (direct) return direct
    // Keep old encoded references callable, but never expose them in the model list.
    const legacy = decodeRouteId(id)
    if (legacy) return this.routes.get(routeId({ key_id: legacy.keyId }, legacy.upstreamModelId)) ?? null
    const visible = [...this.routes.values()].find(route => route.publicId === id)
    if (visible) return visible
    const oldImage = Object.entries(this.imageAliases).find(([, alias]) => alias === id)
    return oldImage ? this.routes.get(oldImage[0]) ?? null : null
  }

  credentialsFor(keyIdValue) {
    const row = this.rows.get(keyId(keyIdValue))
    return row ? { key: row.key, baseURL: row.base_url, row } : null
  }

  rowsForDisplay() {
    return [...this.rows.values()].map((row) => ({
      keyId: String(row.key_id),
      groupId: String(row.group_id),
      groupName: String(row.group_name ?? ""),
      platform: String(row.platform ?? ""),
      displayName: String(row.display_name ?? ""),
      status: String(row.status ?? ""),
      expiresAt: row.expires_at ?? null,
      modelCount: Array.isArray(row.models) ? row.models.length : 0,
      stableAccountId: row.stable_account_id,
    }))
  }

  routesForDisplay() {
    return [...this.routes.entries()].filter(([, route]) => route.model.upstream_model_id !== "gpt-image-2" || route.publicId).map(([id, { key, model }]) => ({
      id: this.routes.get(id).publicId || id,
      keyId: String(key.key_id),
      groupId: String(key.group_id),
      groupName: String(key.group_name ?? ""),
      upstreamModelId: String(model.upstream_model_id),
      displayName: String(model.display_name ?? model.upstream_model_id),
      protocol: String(model.protocol ?? ""),
      reasoning: model.reasoning === true,
    }))
  }

  projection() {
    const modelRoutes = this.routesForDisplay()
    return {
      revision: this.revision,
      keyCount: this.rows.size,
      routeCount: modelRoutes.length,
      rejectedCount: this.rejected.length,
      keys: this.rowsForDisplay(),
      modelRoutes,
      updatedAt: this.updatedAt,
    }
  }

  disposeOwnedOnly() {
    this.rows.clear()
    this.routes.clear()
    this.ownedKeyIds.clear()
    this.imageRouteId = ""
    this.store?.write({
      revision: this.revision,
      ownedKeyIds: [],
      rows: [],
      imageAliases: this.imageAliases,
      imageRouteId: this.imageRouteId,
      updatedAt: new Date().toISOString(),
    })
    this.onChange()
  }
}

export function modelRoute(key, model, duplicateInGroup = "") {
  const id = routeId(key, model.upstream_model_id)
  const groupSuffix = duplicateInGroup ? ` · ${duplicateInGroup}` : ""
  return {
    id,
    providerID: "novaflow",
    name: `${model.display_name || model.upstream_model_id}${groupSuffix}`,
    api: { id, url: String(key.base_url ?? "").replace(/\/+$/, "") + "/v1", npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    limit: { context: Number(model.context_window ?? 0), output: Number(model.max_output_tokens ?? 0) },
    capabilities: {
      temperature: model.capabilities?.imageGeneration !== true,
      reasoning: model.reasoning === true,
      attachment: model.capabilities?.vision === true,
      toolcall: model.capabilities?.imageGeneration !== true && model.capabilities?.tools !== false,
      input: { text: true, image: model.capabilities?.vision === true },
      output: { text: model.capabilities?.imageGeneration !== true, image: model.capabilities?.imageGeneration === true, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: String(model.release_date ?? ""),
    variants: model.reasoning === true
      ? Object.fromEntries((model.reasoning_levels ?? ["low", "medium", "high"]).map((level) => [String(level), {}]))
      : {},
    serviceTiers: Array.isArray(model.service_tiers) ? model.service_tiers : [],
  }
}
