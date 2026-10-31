export class CredentialLoader {
  constructor({ api, session, accounts, config, report = () => {} }) {
    this.api = api
    this.session = session
    this.accounts = accounts
    this.config = config
    this.report = report
    this.pending = null
  }

  keyIdsFromSnapshot(snapshot) {
    const sources = [
      snapshot?.keys,
      snapshot?.key_catalog?.items,
      snapshot?.credentials?.items,
      snapshot?.bootstrap?.keys,
    ]
    for (const source of sources) {
      if (!Array.isArray(source)) continue
      const ids = source
        .map((item) => typeof item === "object" ? item?.key_id : item)
        .filter((item) => item !== undefined && item !== null)
      if (ids.length) return [...new Map(ids.map((id) => [String(id), id])).values()]
    }
    if (Array.isArray(snapshot?.key_ids)) return [...snapshot.key_ids]
    return []
  }

  hasKeyCatalog(snapshot) {
    return Array.isArray(snapshot?.keys)
      || Array.isArray(snapshot?.key_catalog?.items)
      || Array.isArray(snapshot?.credentials?.items)
      || Array.isArray(snapshot?.bootstrap?.keys)
      || Array.isArray(snapshot?.key_ids)
  }

  revisionFromSnapshot(snapshot) {
    return String(
      snapshot?.keys_revision
      ?? snapshot?.revisions?.keys
      ?? snapshot?.key_catalog?.revision
      ?? snapshot?.bootstrap_revision
      ?? "",
    )
  }

  async load({ snapshot = null, signal } = {}) {
    const owner = this.session.ownership?.()
    if (this.pending && this.pendingOwner === owner) return this.pending
    this.pendingOwner = owner
    const pending = this.loadUnshared({ snapshot, signal }).finally(() => {
      if (this.pending === pending) this.pending = null
    })
    this.pending = pending
    return this.pending
  }

  async loadUnshared({ snapshot, signal }) {
    return this.session.withAccess(async (access) => {
      const owner = this.session.ownership?.()
      const source = snapshot ?? await this.api.sync(access, "", signal)
      if (source?.not_modified === true) throw new Error("Credential snapshot cannot be not-modified on a full read")
      if (!this.hasKeyCatalog(source)) {
        throw Object.assign(new Error("NovaFlow sync omitted the authorized key catalog"), { code: "PLUGIN_CONTRACT_INCOMPLETE" })
      }
      const ids = this.keyIdsFromSnapshot(source)
      const expectedRevision = this.revisionFromSnapshot(source)
      if (!ids.length) {
        this.session.assertOwnership?.(owner)
        const empty = this.accounts.reconcile({ revision: expectedRevision, items: [], rejected: [] })
        this.report("credentials.empty", { keyCount: 0 })
        return { ...empty, snapshotRevision: expectedRevision }
      }
      const items = []
      const rejected = []
      let revision = expectedRevision
      for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await this.api.credentialsBatch(access, ids.slice(offset, offset + 100), expectedRevision, signal)
        if (!Array.isArray(result?.items)) throw new Error("NovaFlow credentials batch has no items array")
        items.push(...result.items)
        rejected.push(...(Array.isArray(result?.rejected) ? result.rejected : []))
        if (result.revision) revision = String(result.revision)
      }
      this.session.assertOwnership?.(owner)
      const projection = this.accounts.reconcile({ revision, items, rejected })
      this.report("credentials.ready", { keyCount: projection.keyCount, rejectedCount: projection.rejectedCount })
      return { ...projection, snapshotRevision: this.revisionFromSnapshot(source) }
    }, { signal })
  }
}
