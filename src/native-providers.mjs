import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { PRODUCTION_ORIGIN, PRODUCTION_ORIGIN_ALIASES } from "./config.mjs"
import { stableId, randomId } from "./state-store.mjs"

const CONNECTION_FIELDS = ["key", "chat", "responses", "anthropic", "gemini", "decide", "baseAPI"]
const fingerprint = value => stableId(...CONNECTION_FIELDS.map(field => value[field] || ""))
const failure = (code, message) => Object.assign(new Error(message), { code })

function readConfig(path, optional = true) {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error()
    const text = readFileSync(path, "utf8")
    const value = JSON.parse(text)
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error()
    if (value.providers !== undefined && !Array.isArray(value.providers)) throw new Error()
    return { text, value }
  } catch (error) {
    if (optional && error.code === "ENOENT") return { text: null, value: {} }
    throw failure("PLUGIN_NATIVE_CONFIG_INVALID", "Magpie 供应商配置无法安全读取，请先检查配置文件")
  }
}

function writeConfig(path, before, value) {
  const temporary = path + ".novaflow-" + randomId(8)
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    if (readConfig(path).text !== before.text) throw failure("PLUGIN_NATIVE_CONFIG_CONFLICT", "Magpie 供应商配置正在被修改，请重新同步")
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

export function nativeProviderId(origin, userId, keyId) {
  return "novaflow-key-" + stableId(origin, String(userId), String(keyId)).slice(0, 20)
}

function connectionFor(config, row) {
  const declared = new URL(String(row.base_url || config.origin))
  const allowed = config.origin === PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN_ALIASES : [config.origin]
  if (!allowed.includes(declared.origin) || declared.username || declared.password) {
    throw failure("PLUGIN_NATIVE_ORIGIN_INVALID", "授权 Key 的地址不是当前 NovaFlow 服务地址")
  }
  const root = config.origin
  const base = { key: row.key, chat: "", responses: "", anthropic: "", gemini: "", decide: "", baseAPI: "" }
  switch (String(row.platform || "").toLowerCase()) {
    case "anthropic": return { ...base, anthropic: root, baseAPI: "anthropic" }
    case "gemini": return { ...base, gemini: root + "/v1beta", baseAPI: "gemini" }
    case "antigravity": return { ...base, anthropic: root, gemini: root + "/v1beta", baseAPI: "anthropic" }
    case "composite": return { ...base, chat: root + "/v1", responses: root + "/v1", anthropic: root, gemini: root + "/v1beta", baseAPI: "responses" }
    case "typesafe": return { ...base, decide: root + "/v1", baseAPI: "decide" }
    case "openai": return { ...base, chat: root + "/v1", responses: root + "/v1", baseAPI: "responses" }
    default: return { ...base, chat: root + "/v1", baseAPI: "chat" }
  }
}

// The ledger proves ownership by connection fingerprint, never by name alone.
// Native model caches are read only for the page and explicit initialization.
export class NativeProviderSync {
  constructor({ directory, config, host, accounts, session, store, icon = "" }) {
    Object.assign(this, { directory, config, host, accounts, session, store, icon })
    this.path = join(directory, "providers.json")
    this.lockPath = join(directory, ".novaflow-providers.lock")
    this.tail = Promise.resolve()
  }

  async lock(signal) {
    for (let i = 0; i < 100; i++) {
      signal?.throwIfAborted()
      try {
        const fd = openSync(this.lockPath, "wx", 0o600)
        writeFileSync(fd, String(process.pid))
        return () => { closeSync(fd); unlinkSync(this.lockPath) }
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        try {
          const pid = Number(readFileSync(this.lockPath, "utf8"))
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0) } catch (dead) { if (dead.code === "ESRCH") unlinkSync(this.lockPath) }
          } else if (Date.now() - lstatSync(this.lockPath).mtimeMs > 30_000) unlinkSync(this.lockPath)
        } catch (readError) { if (readError.code !== "ENOENT") throw readError }
        await delay(25, undefined, { signal })
      }
    }
    throw failure("PLUGIN_NATIVE_CONFIG_BUSY", "另一个 NovaFlow 同步正在保存供应商，请稍后重试")
  }

  reconcile(options = {}) {
    const owner = this.session.ownership()
    const pending = this.tail.catch(() => {}).then(() => {
      this.session.assertOwnership(owner)
      return this.apply(options)
    })
    this.tail = pending
    return pending
  }

  async apply({ signal, refresh = false, clear = false, foreignOnly = false } = {}) {
    const owner = this.session.ownership()
    const release = await this.lock(signal)
    let targets, pending, migrationRequired
    try {
      this.session.assertOwnership(owner)
      signal?.throwIfAborted()
      const identity = this.session.projection()
      if (!clear && identity.status !== "authenticated") throw failure("PLUGIN_SESSION_CHANGED", "请先登录 NovaFlow")
      const before = readConfig(this.path)
      const ledger = this.store.read()
      if (foreignOnly && ledger.userId === String(identity.userId) && ledger.origin === this.config.origin) return this.accounts.native
      if (foreignOnly) clear = true
      const entries = ledger.entries || {}
      const desired = new Map()
      const names = new Map()
      const failures = []
      const ids = (before.value.providers || []).map(item => item.id)
      if (new Set(ids).size !== ids.length) throw failure("PLUGIN_NATIVE_CONFIG_INVALID", "Magpie 存在重复供应商标识，请先在供应商页面检查")
      for (const row of clear ? [] : this.accounts.rows.values()) {
        const group = String(row.group_name || row.group_id || "未分组")
        names.set(group, (names.get(group) || 0) + 1)
      }
      for (const row of clear ? [] : this.accounts.rows.values()) {
        const id = nativeProviderId(this.config.origin, identity.userId, row.key_id)
        const group = String(row.group_name || row.group_id || "未分组")
        const name = "NovaFlow · " + group + (names.get(group) > 1 ? " · " + String(row.display_name || row.key_id) : "")
        try {
          desired.set(id, { id, name, ...connectionFor(this.config, row), keyId: String(row.key_id), groupName: group })
        } catch (error) { failures.push({ id, code: error.code, message: error.message }) }
      }
      const nextEntries = {}, providers = [], queue = []
      const remaining = new Map(desired)
      let changed = false
      for (const current of before.value.providers || []) {
        const owned = entries[current.id], wanted = desired.get(current.id)
        if (!owned) {
          providers.push(current)
          if (wanted) {
            failures.push({ id: current.id, code: "PLUGIN_NATIVE_ID_CONFLICT", message: "同名供应商不是本插件创建的，未覆盖" })
            remaining.delete(current.id)
          }
          continue
        }
        if (!(owned.fingerprints || []).includes(fingerprint(current))) {
          providers.push(current)
          nextEntries[current.id] = owned
          failures.push({ id: current.id, code: "PLUGIN_NATIVE_OWNERSHIP_CONFLICT", message: "供应商连接已被手动修改，未覆盖或删除，请在 Magpie 中确认" })
          remaining.delete(current.id)
          continue
        }
        if (!wanted) { changed = true; continue }
        remaining.delete(current.id)
        const { keyId, groupName, ...connection } = wanted
        const next = { ...current, ...connection, name: current.name === owned.name ? wanted.name : current.name }
        // User choices, aliases, disabled state, routing and extra settings stay native.
        providers.push(next)
        const newFingerprint = fingerprint(next)
        const connectionChanged = fingerprint(current) !== newFingerprint
        nextEntries[current.id] = {
          ...owned, keyId, groupName, name: wanted.name,
          fingerprints: [...new Set([fingerprint(current), newFingerprint])],
          pendingRefresh: owned.pendingRefresh || connectionChanged,
        }
        if (JSON.stringify(current) !== JSON.stringify(next)) changed = true
        if (!current.off && (refresh || nextEntries[current.id].pendingRefresh)) queue.push(current.id)
      }
      for (const [id, wanted] of remaining) {
        const { keyId, groupName, ...connection } = wanted
        // A stable website fragment keeps Magpie's automatic duplicate-provider
        // folding from combining different group Keys with numbered names.
        providers.push({ ...connection, ...(this.icon ? { icon: this.icon } : {}), website: this.config.origin + "/#" + id })
        nextEntries[id] = { keyId, groupName, name: wanted.name, fingerprints: [fingerprint(connection)], pendingRefresh: true }
        queue.push(id)
        changed = true
      }
      // Record ownership before installing a connection, so a crash cannot orphan a Key.
      const recoveryEntries = { ...entries }
      for (const [id, entry] of Object.entries(nextEntries)) {
        recoveryEntries[id] = { ...entry, fingerprints: [...new Set([...(entries[id]?.fingerprints || []), ...entry.fingerprints])] }
      }
      const scope = { userId: String(identity.userId || ""), origin: this.config.origin }
      this.store.write({ ...ledger, ...scope, entries: recoveryEntries })
      this.session.assertOwnership(owner)
      if (changed) writeConfig(this.path, before, { ...before.value, providers })
      migrationRequired = ledger.migrationRequired || this.accounts.native.migrationRequired
      this.store.write({ ...ledger, ...scope, entries: nextEntries, migrationRequired })
      pending = { failures, migrationRequired, providers: [] }
      this.accounts.setNativeState(pending)
      targets = { entries: nextEntries, providers, queue }
    } finally { release() }

    for (const id of targets.queue) {
      this.session.assertOwnership(owner)
      signal?.throwIfAborted()
      try {
        await this.host.refreshProvider(id, signal)
        this.session.assertOwnership(owner)
        const unlock = await this.lock(signal)
        try {
          this.session.assertOwnership(owner)
          const ledger = this.store.read(), entry = ledger.entries?.[id]
          if (entry && entry.fingerprints.includes(fingerprint(targets.providers.find(item => item.id === id)))) {
            entry.pendingRefresh = false
            this.store.write(ledger)
          }
        } finally { unlock() }
      } catch (error) {
        this.session.assertOwnership(owner)
        signal?.throwIfAborted()
        pending.failures.push({ id, code: "PLUGIN_NATIVE_REFRESH_FAILED", message: "原生供应商已保存，但 Magpie 获取模型未完成，请重新同步或在供应商页面获取模型" })
      }
    }
    this.session.assertOwnership(owner)
    for (const [id, entry] of Object.entries(targets.entries)) {
      if (!desiredForCurrent(entry, this.accounts, clear)) continue
      try {
        const catalog = await this.host.readProviderCatalog(id)
        this.session.assertOwnership(owner)
        const provider = targets.providers.find(item => item.id === id)
        pending.providers.push({ id, keyId: entry.keyId, groupName: entry.groupName, name: provider?.name || entry.name, off: provider?.off === true, modelCount: catalog.models.length, models: catalog.models })
      } catch {
        pending.failures.push({ id, code: "PLUGIN_NATIVE_CATALOG_UNAVAILABLE", message: "暂时无法读取 Magpie 原生模型缓存" })
      }
    }
    this.session.assertOwnership(owner)
    this.accounts.setNativeState(pending)
    return pending
  }

  clear() { return this.reconcile({ clear: true }) }
  clearForeign() { return this.reconcile({ foreignOnly: true }) }
}

function desiredForCurrent(entry, accounts, clear) {
  return !clear && accounts.rows.has(entry.keyId)
}
