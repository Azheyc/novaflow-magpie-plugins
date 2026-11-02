import { createHash } from "node:crypto"
import { JsonStore, randomId, stableId } from "./state-store.mjs"

const OAUTH_REQUIRED = new Set([
  "PLUGIN_SESSION_REVOKED",
  "PLUGIN_IDENTITY_UNAVAILABLE",
  "PLUGIN_COMPANY_INACTIVE",
  "PLUGIN_MEMBERSHIP_INACTIVE",
])

export class SessionManager {
  constructor({ api, store, now = () => Date.now() }) {
    this.api = api
    this.store = store ?? new JsonStore("", {})
    this.now = now
    this.state = this.store.read()
    this.savedState = JSON.stringify(this.state)
    this.generation = Number.isSafeInteger(this.state.generation) ? this.state.generation : 0
    this.refreshing = new Map()
    this.listeners = new Set()
  }

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(reason) {
    for (const listener of this.listeners) {
      try {
        listener(this.projection(), reason)
      } catch {}
    }
  }

  persist() {
    if (JSON.stringify(this.store.read()) !== this.savedState) {
      this.reload()
      throw Object.assign(new Error("NovaFlow session changed before saving"), { code: "PLUGIN_SESSION_CHANGED" })
    }
    this.state.generation = this.generation
    this.state.sessionRevision = randomId()
    this.store.write(this.state)
    this.savedState = JSON.stringify(this.store.read())
  }

  reload() {
    const next = this.store.read()
    const saved = JSON.stringify(next)
    if (saved === this.savedState) return false
    const previous = this.state
    this.state = next
    this.savedState = saved
    const credentialChanged = previous.access !== next.access || previous.refresh !== next.refresh
    const loginChanged = credentialChanged || previous.loginRevision !== next.loginRevision || previous.status !== next.status
    // A login in another process invalidates work even if it reused a key
    // and persisted the same generation as this process.
    if (loginChanged || previous.accountId !== next.accountId) this.generation = Math.max(this.generation + 1, Number(next.generation) || 0)
    this.emit(previous.accountId !== next.accountId ? "account-switch" : loginChanged ? "login" : "session-reloaded")
    return true
  }

  ownership() {
    this.reload()
    return stableId(this.state.status, this.state.accountId, this.state.access, this.state.refresh, this.state.loginRevision)
  }

  assertOwnership(owner) {
    this.reload()
    if (owner !== this.ownership()) {
      throw Object.assign(new Error("NovaFlow session changed; retry with the current account"), { code: "PLUGIN_SESSION_CHANGED" })
    }
  }

  projection() {
    this.reload()
    const authenticated = this.state.status === "authenticated"
    return {
      status: this.state.status ?? "signed_out",
      userId: authenticated ? this.state.userId ?? null : null,
      displayName: authenticated ? this.state.displayName ?? "" : "",
      accountMode: authenticated ? this.state.accountMode ?? null : null,
      role: authenticated ? this.state.role ?? null : null,
      capabilities: authenticated ? this.state.bootstrap?.capabilities ?? {} : {},
      company: authenticated && this.state.bootstrap?.company ? {
        id: this.state.bootstrap.company.id,
        displayName: this.state.bootstrap.company.display_name,
        timezone: this.state.bootstrap.company.timezone,
        status: this.state.bootstrap.company.status,
      } : null,
      generation: this.generation,
      logoutSynced: this.state.logoutSynced !== false,
      lastError: this.state.lastError ?? "",
    }
  }

  internalAuth() {
    this.reload()
    if (this.state.status !== "authenticated" || !this.state.access) return null
    return {
      access: this.state.access,
      refresh: this.state.refresh,
      expiresAt: this.state.expiresAt,
      userId: this.state.userId,
    }
  }

  async acceptLogin(result, { owner } = {}) {
    // Provider credentials enter the same session boundary as token pairs.
    const access = result?.access_token ?? result?.access
    const refresh = result?.refresh_token ?? result?.refresh
    if (!access || !refresh) throw new Error("NovaFlow login returned no token pair")
    const bootstrap = await this.api.bootstrap(access)
    if (!bootstrap || bootstrap.schema_version !== 1) {
      throw Object.assign(new Error("NovaFlow contract schema is unsupported"), { code: "PLUGIN_SCHEMA_UNSUPPORTED" })
    }
    if (owner !== undefined) this.assertOwnership(owner)
    else this.reload()
    const previousAccount = this.state.accountId
    const credential = stableId(access, refresh)
    const supersededCredentials = new Set(this.state.supersededCredentials ?? [])
    if (this.state.access && this.state.refresh) supersededCredentials.add(stableId(this.state.access, this.state.refresh))
    supersededCredentials.delete(credential)
    this.generation++
    const accountId = String(bootstrap.user_id ?? result.accountId ?? stableId(access).slice(0, 24))
    this.state = {
      status: "authenticated",
      accountId,
      userId: String(bootstrap.user_id ?? ""),
      displayName: String(bootstrap.display_name ?? ""),
      accountMode: bootstrap.account_mode === "enterprise" ? "enterprise" : "personal",
      role: String(bootstrap.role ?? ""),
      access: String(access),
      refresh: String(refresh),
      expiresAt: Number(result.expires ? result.expires : this.now() + Number(result.expires_in ?? 7200) * 1000),
      bootstrap,
      loginRevision: randomId(),
      supersededCredentials: [...supersededCredentials].slice(-32),
      localLogout: false,
      logoutSynced: true,
      lastError: "",
      generation: this.generation,
    }
    this.persist()
    this.emit(previousAccount && previousAccount !== accountId ? "account-switch" : "login")
    return { accountId, bootstrap }
  }

  async activateAuth(auth) {
    this.reload()
    if (!auth || auth.type !== "oauth" || !auth.access || !auth.refresh) {
      throw Object.assign(new Error("Sign in to NovaFlow in Magpie"), { signIn: "expired" })
    }
    // Magpie shows the provider's display name as accountId. NovaFlow's
    // stable identity travels beside it in uid, so a UI label change never
    // looks like a different account and invalidates an in-flight sync.
    // Accounts saved before uid existed are matched by their token pair.
    const sameSecret = this.state.access === auth.access || this.state.refresh === auth.refresh
    const accountId = String(auth.uid || (sameSecret ? this.state.accountId : "") || stableId(auth.access).slice(0, 24))
    if (this.state.localLogout && (sameSecret || this.state.loggedOutCredential === stableId(auth.access, auth.refresh))) {
      throw Object.assign(new Error("NovaFlow was signed out here; sign in again in Magpie"), { signIn: "expired" })
    }
    if (this.state.supersededCredentials?.includes(stableId(auth.access, auth.refresh))) {
      throw Object.assign(new Error("NovaFlow credentials were replaced; use the current sign-in"), { code: "PLUGIN_SESSION_CHANGED" })
    }
    if (
      this.state.status === "authenticated"
      && this.state.accountId === accountId
      && sameSecret
      && Number(this.state.expiresAt ?? 0) >= Number(auth.expires ?? 0)
      && this.state.access
      && this.state.refresh
    ) {
      return this.internalAuth()
    }
    const switched = !!this.state.accountId && this.state.accountId !== accountId
    const changed = switched || !sameSecret
    if (changed) {
      // Read the identity with the incoming credential before publishing it;
      // no request or page may pair the new credential with the old user.
      await this.acceptLogin(auth, { owner: this.ownership() })
      return this.internalAuth()
    }
    this.state = {
      ...this.state,
      status: "authenticated",
      accountId,
      access: String(auth.access),
      refresh: String(auth.refresh),
      expiresAt: Number(auth.expires ?? 0),
      localLogout: false,
      lastError: "",
      generation: this.generation,
    }
    this.persist()
    return this.internalAuth()
  }

  isDue(leadMs = 5 * 60_000) {
    return !!this.state.expiresAt && this.state.expiresAt - leadMs <= this.now()
  }

  async ensureFresh({ force = false, signal } = {}) {
    this.reload()
    if (this.state.status !== "authenticated") {
      throw Object.assign(new Error("Sign in to NovaFlow in Magpie"), { signIn: "expired" })
    }
    if (!force && !this.isDue()) return this.state.access
    const refresh = this.state.refresh
    const owner = this.ownership()
    const key = createHash("sha256").update(refresh).digest("hex")
    if (this.refreshing.has(key)) return this.refreshing.get(key)
    const promise = this.api.refresh(refresh).then((tokens) => {
      this.assertOwnership(owner)
      if (!tokens?.access_token || !tokens?.refresh_token) throw new Error("NovaFlow refresh returned an incomplete token pair")
      this.state.access = tokens.access_token
      this.state.refresh = tokens.refresh_token
      this.state.expiresAt = this.now() + Number(tokens.expires_in ?? 7200) * 1000
      this.state.status = "authenticated"
      this.state.lastError = ""
      this.persist()
      this.emit("refresh")
      return this.state.access
    }).catch((error) => {
      this.assertOwnership(owner)
      if (error.status === 401 || error.status === 403 || OAUTH_REQUIRED.has(error.code)) {
        this.state.status = "expired"
        this.state.access = ""
        this.state.refresh = ""
        this.state.lastError = error.message
        this.persist()
        this.emit("expired")
        throw Object.assign(new Error("NovaFlow sign-in expired; sign in again"), { signIn: "expired", cause: error })
      }
      throw error
    }).finally(() => {
      this.refreshing.delete(key)
    })
    this.refreshing.set(key, promise)
    return promise
  }

  async withAccess(fn, { signal } = {}) {
    let access = await this.ensureFresh({ signal })
    let owner = this.ownership()
    try {
      const result = await fn(access)
      this.assertOwnership(owner)
      return result
    } catch (error) {
      this.assertOwnership(owner)
      if (error.status !== 401) throw error
      access = await this.ensureFresh({ force: true, signal })
      owner = this.ownership()
      const result = await fn(access)
      this.assertOwnership(owner)
      return result
    }
  }

  async updateBootstrap(bootstrap, { owner } = {}) {
    this.reload()
    if (owner !== undefined) this.assertOwnership(owner)
    if (!bootstrap || bootstrap.schema_version !== 1) return
    const accountId = String(bootstrap.user_id ?? this.state.userId ?? "")
    const switched = accountId && this.state.accountId && accountId !== this.state.accountId
    if (switched) {
      this.generation++
    }
    this.state.accountId = accountId
    this.state.userId = accountId
    this.state.bootstrap = bootstrap
    this.state.displayName = String(bootstrap.display_name ?? this.state.displayName ?? "")
    this.state.accountMode = bootstrap.account_mode === "enterprise" ? "enterprise" : "personal"
    this.state.role = String(bootstrap.role ?? "")
    this.persist()
    if (switched) this.emit("account-switch")
  }

  async logout() {
    this.reload()
    const loggedOutCredential = stableId(this.state.access, this.state.refresh)
    this.generation++
    this.state = {
      ...this.state,
      status: "signed_out",
      access: "",
      refresh: "",
      expiresAt: 0,
      localLogout: true,
      loggedOutCredential,
      logoutSynced: true,
      lastError: "",
      generation: this.generation,
    }
    this.persist()
    this.emit("logout")
    // The connection key belongs to the platform account, not this installation.
    // Signing out locally must not revoke it for this or other devices.
    return { ok: true, synced: true }
  }

  revoke(reason = "NovaFlow access was revoked") {
    this.reload()
    this.generation++
    this.state = {
      ...this.state,
      status: "expired",
      access: "",
      refresh: "",
      expiresAt: 0,
      lastError: reason,
      generation: this.generation,
    }
    this.persist()
    this.emit("revoked")
  }

  clearCredentials() {
    this.reload()
    this.generation++
    this.state = {
      ...this.state,
      status: "signed_out",
      accountId: "",
      userId: "",
      displayName: "",
      accountMode: null,
      role: null,
      access: "",
      refresh: "",
      expiresAt: 0,
      bootstrap: null,
      lastError: "",
      generation: this.generation,
    }
    this.persist()
    this.emit("credentials-cleared")
  }
}
