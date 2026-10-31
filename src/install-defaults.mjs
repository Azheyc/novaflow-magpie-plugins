import { JsonStore, randomId } from "./state-store.mjs"

const FIELD_RE = /^[a-z][a-z0-9_.-]{0,127}$/

function validConfig(value) {
  if (!Array.isArray(value)) return { valid: false, reason: "wait_config", fields: [] }
  const fields = []
  for (const item of value) {
    if (!item || typeof item !== "object") return { valid: false, reason: "invalid_config", fields: [] }
    if (!FIELD_RE.test(String(item.field ?? ""))) return { valid: false, reason: "invalid_config", fields: [] }
    if (item.value === undefined) return { valid: false, reason: "invalid_config", fields: [] }
    fields.push({
      id: String(item.id ?? `${item.platform || "global"}:${item.field}`),
      platform: String(item.platform ?? "global"),
      field: String(item.field),
      value: item.value,
    })
  }
  const ids = fields.map((field) => field.id)
  if (new Set(ids).size !== ids.length) return { valid: false, reason: "duplicate_field", fields: [] }
  return { valid: true, reason: fields.length ? "ready" : "wait_config", fields }
}

export class InstallDefaultsRunner {
  constructor({ adapter, markerStore, backupStore, config = null, now = () => new Date(), platform = process.platform }) {
    this.adapter = adapter
    this.marker = markerStore ?? new JsonStore("", {})
    this.backups = backupStore ?? new JsonStore("", {})
    this.config = config
    this.now = now
    this.platform = platform
  }

  status() {
    const value = this.marker.read()
    return {
      status: value.status ?? "wait_config",
      reason: value.reason ?? "wait_config",
      instanceId: value.instanceId ?? "",
      fields: Object.keys(value.fields ?? {}),
      failures: Object.entries(value.fields ?? {}).filter(([, item]) => item.status !== "success").map(([id]) => id),
      updatedAt: value.updatedAt ?? "",
    }
  }

  async run() {
    const checked = validConfig(this.config?.fields ?? this.config)
    const value = this.marker.read()
    if (!value.instanceId) value.instanceId = randomId(18)
    if (!checked.valid) {
      value.status = "wait_config"
      value.reason = checked.reason
      value.updatedAt = this.now().toISOString()
      this.marker.write(value)
      return this.status()
    }
    value.fields ??= {}
    value.status = "running"
    value.reason = ""
    for (const field of checked.fields) {
      if (value.fields[field.id]?.status === "success") continue
      try {
        if (!Object.hasOwn(value.fields[field.id] ?? {}, "previous")) {
          try {
            value.fields[field.id] = { ...value.fields[field.id], previous: await this.adapter.read(field.platform, field.field) }
            this.backups.write({ ...this.backups.read(), [field.id]: value.fields[field.id].previous })
          } catch (error) {
            if (error.code !== "HOST_SETTINGS_UNSUPPORTED") throw error
            value.fields[field.id] = { ...value.fields[field.id], previous: undefined }
          }
        }
        await this.adapter.write(field.platform, field.field, field.value)
        const current = await this.adapter.read(field.platform, field.field)
        if (JSON.stringify(current) !== JSON.stringify(field.value)) throw new Error("Default setting could not be read back")
        value.fields[field.id] = { ...value.fields[field.id], status: "success", updatedAt: this.now().toISOString() }
      } catch (error) {
        value.fields[field.id] = {
          ...value.fields[field.id],
          status: "failed",
          reason: error?.code === "HOST_SETTINGS_UNSUPPORTED" ? "host_settings_unsupported" : "write_failed",
          updatedAt: this.now().toISOString(),
        }
      }
      this.marker.write(value)
    }
    const complete = checked.fields.every((field) => value.fields[field.id]?.status === "success")
    value.status = complete ? "complete" : "partial_failure"
    value.updatedAt = this.now().toISOString()
    this.marker.write(value)
    return this.status()
  }
}
