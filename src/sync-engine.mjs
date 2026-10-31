import { JsonStore } from "./state-store.mjs"

const FATAL_CODES = new Set([
  "PLUGIN_SESSION_REVOKED",
  "PLUGIN_IDENTITY_UNAVAILABLE",
  "PLUGIN_COMPANY_INACTIVE",
  "PLUGIN_MEMBERSHIP_INACTIVE",
])

function configError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "Config payload is invalid"
  if (payload.schema_version !== 1) return "Config schema is unsupported"
  const forbidden = ["key_id", "default_key_id", "recommended_key_id"]
  if (forbidden.some((name) => Object.hasOwn(payload, name))) return "Company config must not name a key"
  for (const field of ["recommended_group_id", "recommended_model_id"]) {
    if (payload[field] !== null && payload[field] !== undefined && (typeof payload[field] !== "string" || payload[field].length > 200)) {
      return `${field} is invalid`
    }
  }
  return ""
}

export class SyncEngine {
  constructor({
    config,
    api,
    session,
    credentials,
    accounts,
    skills,
    defaults,
    preferences,
    hostVersion = config.hostMinVersion,
    instanceId,
    snapshotStore,
    now = () => Date.now(),
    report = () => {},
  }) {
    this.config = config
    this.api = api
    this.session = session
    this.credentials = credentials
    this.accounts = accounts
    this.skills = skills
    this.defaults = defaults
    this.preferences = preferences
    this.hostVersion = hostVersion
    this.instanceId = instanceId
    this.snapshotStore = snapshotStore ?? new JsonStore("", {})
    this.now = now
    this.report = report
    this.running = null
    this.timer = null
    this.controller = null
    this.stopped = true
    this.failures = 0
    this.state = {
      status: "wait_connection",
      revision: "",
      lastAttemptAt: "",
      lastSuccessAt: "",
      nextAttemptAt: "",
      errorCode: "",
      requestId: "",
      components: {
        keys: "pending",
        settings: "pending",
        skills: "pending",
      },
      stale: false,
      appliedRevision: "",
    }
    const cached = this.snapshotStore.read()
    if (cached?.state) {
      this.state = { ...this.state, ...cached.state, status: cached.state.lastSuccessAt ? "stale" : cached.state.status, stale: !!cached.state.lastSuccessAt }
    }
    this.configPayload = cached?.config ?? null
    this.usage = cached?.usage ?? null
  }

  projection() {
    return {
      ...structuredClone(this.state),
      config: this.configPayload?.payload ?? null,
      configRevision: this.configPayload?.revision ?? this.configPayload?.payload?.revision ?? "",
      usage: this.usage,
      defaults: this.defaults.status(),
      accounts: this.accounts.projection(),
      skills: this.skills.projection(),
    }
  }

  isFatal(error) {
    return error?.status === 401
      || error?.status === 403
      || FATAL_CODES.has(error?.code)
      || error?.code === "PLUGIN_SCHEMA_UNSUPPORTED"
  }

  saveState() {
    this.snapshotStore.write({
      state: { ...this.state, stale: false },
      config: this.configPayload,
      usage: this.usage,
      skillsCatalog: this.skills.projection().catalog,
    })
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    if (this.running) {
      this.restartPending = true
      return
    }
    void this.syncNow("startup")
  }

  resetSession() {
    this.stop("NovaFlow session changed")
    this.configPayload = null
    this.usage = null
    this.failures = 0
    this.state = {
      ...this.state,
      status: "wait_connection",
      revision: "",
      appliedRevision: "",
      lastAttemptAt: "",
      lastSuccessAt: "",
      nextAttemptAt: "",
      errorCode: "",
      requestId: "",
      stale: false,
      components: { keys: "pending", settings: "pending", skills: "pending" },
    }
    this.saveState()
  }

  stop(reason = "Sync stopped") {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = null
    this.controller?.abort(new Error(reason))
    this.controller = null
  }

  nextDelay() {
    if (this.failures) return Math.min(this.config.retryMaxMs, 1000 * 2 ** Math.min(8, this.failures - 1))
    const jitter = 1 + (Math.random() * 2 - 1) * this.config.pollingJitter
    return Math.max(1000, Math.round(this.config.pollingMs * jitter))
  }

  schedule(delay = this.nextDelay()) {
    clearTimeout(this.timer)
    if (this.stopped) return
    const at = this.now() + delay
    this.state.nextAttemptAt = new Date(at).toISOString()
    this.timer = setTimeout(() => {
      void this.syncNow("poll")
    }, delay)
    this.timer.unref?.()
  }

  async syncNow(reason = "manual") {
    if (this.running) return this.running
    if (this.stopped && reason === "poll") return this.state
    this.running = this.runOnce(reason).finally(() => {
      this.running = null
      if (this.restartPending && !this.stopped) {
        this.restartPending = false
        clearTimeout(this.timer)
        void this.syncNow("session")
      }
    })
    return this.running
  }

  async runOnce(reason) {
    if (this.session.projection().status !== "authenticated") {
      this.state.status = "wait_connection"
      this.state.errorCode = ""
      return this.projection()
    }
    this.controller?.abort(new Error("Superseded by a new sync"))
    this.controller = new AbortController()
    const signal = this.controller.signal
    const generation = this.session.generation
    const retryComponents = this.state.status === "partial" || Object.values(this.state.components).includes("failed")
    this.state.lastAttemptAt = new Date(this.now()).toISOString()
    this.state.status = this.state.lastSuccessAt ? "refreshing" : "syncing"
    this.state.errorCode = ""
    this.state.requestId = ""
    try {
      let snapshot = await this.session.withAccess((access) => this.api.sync(access, this.state.revision, signal), { signal })
      let unchanged = snapshot?.not_modified === true || snapshot?.not_modified === undefined && snapshot?.revision === this.state.revision
      if (unchanged && retryComponents) {
        // Request a complete snapshot when a prior component needs recovery.
        snapshot = await this.session.withAccess((access) => this.api.sync(access, "", signal), { signal })
        unchanged = false
      }
      if (!unchanged && (!snapshot || snapshot.not_modified || snapshot.schema_version !== 1 || !snapshot.revision)) {
        throw Object.assign(new Error("NovaFlow sync schema is unsupported"), { code: "PLUGIN_SCHEMA_UNSUPPORTED" })
      }
      if (generation !== this.session.generation || signal.aborted) throw Object.assign(new Error("Stale sync response"), { code: "SYNC_STALE_RESPONSE" })
      await this.session.withAccess(async (access) => {
        const owner = this.session.ownership?.()
        const bootstrap = await this.api.bootstrap(access, signal)
        if (bootstrap?.schema_version !== 1) throw Object.assign(new Error("NovaFlow bootstrap schema is unsupported"), { code: "PLUGIN_SCHEMA_UNSUPPORTED" })
        await this.session.updateBootstrap(bootstrap, { owner })
      }, { signal })
      try {
        this.usage = await this.session.withAccess((access) => this.api.usage(access, signal), { signal })
      } catch (error) {
        if (this.isFatal(error)) throw error
      }
      if (generation !== this.session.generation || signal.aborted) throw Object.assign(new Error("Stale sync response"), { code: "SYNC_STALE_RESPONSE" })
      let storeFailure = null
      const companySkills = this.session.projection().accountMode === "enterprise"
      try {
        if (companySkills) await this.skills.refreshStore(signal)
      } catch (error) {
        if (this.isFatal(error)) throw error
        storeFailure = error
      }
      if (generation !== this.session.generation || signal.aborted) throw Object.assign(new Error("Stale sync response"), { code: "SYNC_STALE_RESPONSE" })
      if (unchanged) {
        this.state.components.skills = !companySkills ? "unknown" : storeFailure ? "failed" : "success"
        this.state.status = storeFailure ? "partial" : "ready"
        this.state.stale = false
        this.failures = 0
        this.saveState()
        return this.projection()
      }

      const components = { keys: "pending", settings: "pending", skills: "pending" }
      const failures = []
      let credentialProjection
      try {
        credentialProjection = await this.credentials.load({ snapshot, signal })
        components.keys = "success"
      } catch (error) {
        if (error.code === "PLUGIN_KEY_REVISION_CONFLICT") {
          this.state.revision = ""
          throw error
        }
        components.keys = "failed"
        failures.push({ name: "keys", status: "failed", code: error.code || "KEYS_FAILED" })
        if (this.isFatal(error)) throw error
      }
      if (generation !== this.session.generation || signal.aborted) throw Object.assign(new Error("Stale sync response"), { code: "SYNC_STALE_RESPONSE" })

      const configPayload = snapshot.config ?? (snapshot.config_payload ? { payload: snapshot.config_payload, revision: snapshot.config_revision } : null)
      let config = null
      try {
        if (configPayload) {
          const invalid = configError(configPayload.payload ?? configPayload)
          if (invalid) throw Object.assign(new Error(invalid), { code: "PLUGIN_CONFIG_INVALID" })
          config = configPayload
        }
        components.settings = "success"
      } catch (error) {
        components.settings = "failed"
        failures.push({ name: "settings", status: "failed", code: error.code || "CONFIG_FAILED" })
        if (this.isFatal(error)) throw error
      }

      const skillResult = { installed: 0, unchanged: 0, removed: 0, failed: [] }
      components.skills = !companySkills ? "unknown" : storeFailure ? "failed" : "success"
      if (storeFailure) failures.push({ name: "skills", status: "failed", code: storeFailure.code || "SKILLS_FAILED" })

      // Host initialization is only triggered by the page command, never sync.

      this.configPayload = config ? { payload: config.payload ?? config, revision: String(config.revision ?? config.payload?.revision ?? "") } : null
      this.state.revision = String(snapshot.revision)
      this.state.appliedRevision = String(snapshot.revision)
      this.state.components = components
      this.state.lastSuccessAt = new Date(this.now()).toISOString()
      this.state.stale = false
      this.state.status = failures.length ? "partial" : "ready"
      this.failures = 0
      this.saveState()
      this.report("sync.applied", {
        revision: this.state.revision,
        keys: credentialProjection?.keyCount ?? 0,
        skillsInstalled: skillResult.installed,
        partial: failures.length,
        reason,
      })
      await this.sendReceipt(failures, signal)
      return this.projection()
    } catch (error) {
      if (generation !== this.session.generation || signal.aborted || error.code === "PLUGIN_SESSION_CHANGED") return this.projection()
      this.failures++
      this.state.status = this.isFatal(error) ? "blocked" : "offline"
      this.state.errorCode = String(error.code || (error.status ? `HTTP_${error.status}` : "SYNC_FAILED"))
      this.state.requestId = String(error.requestId ?? "")
      this.state.stale = !!this.state.lastSuccessAt
      if (this.isFatal(error)) {
        this.session.revoke(error.message)
        this.accounts.disposeOwnedOnly()
      }
      this.saveState()
      this.report("sync.failed", { code: this.state.errorCode, status: error.status ?? 0, stale: this.state.stale, reason, message: String(error?.message ?? "") })
      return this.projection()
    } finally {
      if (this.running === null && !this.stopped) this.schedule()
      else if (!this.stopped) this.schedule()
    }
  }

  async sendReceipt(failures, signal) {
    const components = [
      { name: "keys", status: this.state.components.keys, ...(failures.find((item) => item.name === "keys")?.code ? { code: failures.find((item) => item.name === "keys").code } : {}) },
      { name: "skills", status: this.state.components.skills, ...(failures.find((item) => item.name === "skills")?.code ? { code: failures.find((item) => item.name === "skills").code } : {}) },
      { name: "settings", status: this.state.components.settings, ...(failures.find((item) => item.name === "settings")?.code ? { code: failures.find((item) => item.name === "settings").code } : {}) },
    ]
    const receipt = {
      instance_id: this.instanceId,
      revision: this.state.revision,
      client_version: this.config.pluginVersion,
      host_version: this.hostVersion,
      components,
      reported_at: new Date(this.now()).toISOString(),
    }
    try {
      await this.session.withAccess((access) => this.api.receipt(access, receipt, signal), { signal })
      this.state.receipt = "success"
    } catch (error) {
      this.state.receipt = "failed"
      this.state.receiptCode = String(error.code || "RECEIPT_FAILED")
      this.saveState()
    }
  }

  async loadAllSkills(signal) {
    const items = []
    const seen = new Set()
    let cursor = ""
    for (let page = 0; page < 1000; page++) {
      const response = await this.session.withAccess((access) => this.api.skills(access, cursor, signal), { signal })
      if (!response || !Array.isArray(response.items)) throw Object.assign(new Error("NovaFlow skill cursor response is invalid"), { code: "SKILL_CURSOR_INVALID" })
      items.push(...response.items)
      const next = response.next_cursor ?? response.next ?? ""
      if (!next) return items
      if (typeof next !== "string" || seen.has(next)) throw Object.assign(new Error("NovaFlow skill cursor repeated"), { code: "SKILL_CURSOR_INVALID" })
      seen.add(next)
      cursor = next
    }
    throw Object.assign(new Error("NovaFlow skill cursor exceeded its limit"), { code: "SKILL_CURSOR_INVALID" })
  }
}

export { FATAL_CODES, configError }
