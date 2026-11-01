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

export class AccountManager {
  constructor({ onChange = () => {}, store = null } = {}) {
    this.onChange = onChange
    this.store = store
    this.revision = ""
    this.ownedKeyIds = new Set()
    this.rows = new Map()
    this.native = { providers: [], failures: [], migrationRequired: false }
    this.rejected = []
    this.updatedAt = ""
    if (store) {
      const saved = store.read()
      this.revision = String(saved.revision ?? "")
      this.ownedKeyIds = new Set(Array.isArray(saved.ownedKeyIds) ? saved.ownedKeyIds.map(String) : [])
      this.rows = new Map((Array.isArray(saved.rows) ? saved.rows : []).map(({ models, ...row }) => [keyId(row.key_id), row]))
      this.native = saved.native || { providers: [], failures: [], migrationRequired: saved.rows?.some(row => row.models?.length) === true }
    }
  }

  persist() {
    this.store?.write({
      revision: this.revision,
      ownedKeyIds: [...this.ownedKeyIds],
      rows: [...this.rows.values()],
      native: this.native,
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
      this.rows.set(keyId(item.key_id), {
        ...item,
        key_id: item.key_id,
        group_id: item.group_id,
        stable_account_id: `nfk_${stableId("key", item.key_id, item.group_id).slice(0, 24)}`,
      })
    }
    this.revision = String(payload?.revision ?? this.revision)
    this.updatedAt = now
    this.persist()
    this.onChange()
    return this.projection()
  }

  setNativeState(value) {
    this.native = structuredClone(value)
    this.persist()
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
      modelCount: this.native.providers.find(item => item.keyId === String(row.key_id))?.modelCount ?? 0,
      stableAccountId: row.stable_account_id,
    }))
  }

  projection() {
    const modelRoutes = this.native.providers.flatMap(provider => (provider.models || []).map(model => ({
      id: provider.id + "/" + model.id,
      providerId: provider.id,
      keyId: provider.keyId,
      groupName: provider.groupName,
      upstreamModelId: model.id,
      displayName: model.name || model.id,
      imageGeneration: model.draws === true,
    })))
    return {
      revision: this.revision,
      keyCount: this.rows.size,
      routeCount: modelRoutes.length,
      rejectedCount: this.rejected.length,
      keys: this.rowsForDisplay(),
      modelRoutes,
      native: structuredClone(this.native),
      updatedAt: this.updatedAt,
    }
  }

  disposeOwnedOnly() {
    this.rows.clear()
    this.ownedKeyIds.clear()
    this.native = { providers: [], failures: [], migrationRequired: this.native.migrationRequired }
    this.store?.write({
      revision: this.revision,
      ownedKeyIds: [],
      rows: [],
      native: this.native,
      updatedAt: new Date().toISOString(),
    })
    this.onChange()
  }
}
