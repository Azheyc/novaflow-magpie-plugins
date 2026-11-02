import { readFile, lstat, writeFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { randomId } from "./state-store.mjs"

async function readObject(path, optional = false) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("初始化配置文件必须是普通文件")
    const text = await readFile(path, "utf8")
    let value
    try { value = JSON.parse(text) } catch { throw new Error("Magpie 配置格式不正确，请修复后重试") }
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("初始化配置文件格式不正确")
    return { text, value, links: info.nlink }
  } catch (error) {
    if (optional && error.code === "ENOENT") return { text: null, value: {} }
    throw error
  }
}

// Only these two host settings can be changed, and only by the explicit command.
export class ManualInitialization {
  constructor({ host, accounts, markerStore, backupStore, directory }) {
    Object.assign(this, { host, accounts, markerStore, backupStore, directory })
    this.pending = null
  }
  status() {
    const marker = this.markerStore.read()
    const fields = marker.fields || {}
    const needsImageCheck = fields.imageGen?.status === "success" && fields.imageGen.hostValidated !== true
    return {
      status: needsImageCheck ? "partial_failure" : marker.status === "running" && !this.pending ? "partial_failure" : marker.status === "wait_config" || !marker.status ? "pending" : marker.status,
      fields: Object.keys(fields).filter(key => fields[key].status === "success" && !(key === "imageGen" && needsImageCheck)),
      failures: Object.entries(fields).filter(([key, item]) => item.status !== "success" || (key === "imageGen" && needsImageCheck)).map(([key]) => key),
      results: Object.entries(fields).map(([id, item]) => ({ id, status: id === "imageGen" && needsImageCheck ? "pending" : item.status, message: id === "imageGen" && needsImageCheck ? "请点击初始化配置，重新确认生图模型" : item.message || "" })),
      updatedAt: marker.updatedAt || "",
      manual: true,
    }
  }
  run() {
    if (!this.pending) this.pending = this.apply().finally(() => { this.pending = null })
    return this.pending
  }
  async editSetting(field, value) {
    if (!['imageGen', 'updateChannel'].includes(field)) throw new Error("不支持的初始化字段")
    const path = join(this.directory, "settings.json")
    const before = await readObject(path, true)
    if (before.links > 1) throw new Error("设置文件使用了硬链接，请在 Magpie 设置中手动选择此项")
    const backup = this.backupStore.read()
    if (!Object.hasOwn(backup, field)) this.backupStore.write({ ...backup, [field]: { present: Object.hasOwn(before.value, field), value: before.value[field] ?? null } })
    if (before.value[field] === value) return
    const temporary = path + ".novaflow-" + randomId(8)
    try {
      await writeFile(temporary, JSON.stringify({ ...before.value, [field]: value }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
      // Never merge from an old settings snapshot over a concurrent user edit.
      const current = await readObject(path, true)
      if (current.text !== before.text) throw new Error("Magpie 设置正在被修改，请重试初始化")
      await rename(temporary, path)
      if ((await readObject(path)).value[field] !== value) throw new Error("设置保存后校验失败，请重试")
    } finally { await rm(temporary, { force: true }) }
  }
  async imageMCP() {
    if (!this.host.available) throw new Error("暂时无法连接 Magpie，请重新打开插件页面后重试")
    const applied = (await readObject(join(this.directory, "applied.json"), true)).value
    const agents = []
    for (const [id, entry] of Object.entries(applied)) {
      const model = entry?.fields?.model
      if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(id) || typeof model !== "string" || !model || /\s/.test(model)) continue
      const current = await this.host.run([id, "model"])
      const output = current.stdout.replace(/\x1b\[[0-9;]*m/g, "").trim()
      if (output.endsWith(" " + model)) agents.push(id)
    }
    const path = join(this.directory, "library.json")
    const library = (await readObject(path, true)).value
    const existing = (library.mcp || []).find(item => item.name === "magpie-image")
    if (existing && (existing.transport !== "stdio" || JSON.stringify(existing.args) !== JSON.stringify(["mcp", "image"]) || existing.command !== this.host.magpiePath)) {
      throw new Error("资料库已有不同的 magpie-image 配置，请先在 Magpie 中核对")
    }
    const backups = this.backupStore.read()
    if (!Object.hasOwn(backups, "mcp")) this.backupStore.write({ ...backups, mcp: existing || null })
    const targets = [...new Set([...(existing?.agents || []), ...agents])].filter(id => /^[a-z0-9][a-z0-9_.-]{0,79}$/.test(id)).sort()
    if (!existing) {
      await this.host.run(["library", "mcp", "add", "magpie-image", this.host.magpiePath, "mcp", "image", "agents=" + (targets.join(",") || "none")], { timeout: 60_000 })
    } else if (targets.some(id => !existing.agents?.includes(id))) {
      await this.host.run(["library", "mcp", "agents", "magpie-image", targets.join(",")], { timeout: 60_000 })
    }
    let afterData = (await readObject(path)).value
    const linked = id => afterData.applied?.[id]?.mcp?.includes("magpie-image") || (afterData.MCPHub === true && afterData.applied?.[id]?.mcp?.includes("magpie"))
    if (agents.some(id => !linked(id))) {
      await this.host.run(["library", "sync"], { timeout: 60_000 })
      afterData = (await readObject(path)).value
    }
    const after = afterData.mcp?.find(item => item.name === "magpie-image")
    if (!after || after.command !== this.host.magpiePath || JSON.stringify(after.args) !== JSON.stringify(["mcp", "image"]) || !targets.every(id => after.agents?.includes(id)) || agents.some(id => !linked(id))) throw new Error("MCP 安装或 Agent 关联尚未确认，请重试")
    return targets.length ? `已安装并关联 ${targets.length} 个已接管 Agent` : "已安装，当前没有已接管的 Agent"
  }
  async imageReference() {
    const native = this.accounts.projection().native
    for (const item of native?.providers || []) {
      if (item.off) continue
      const providers = (await readObject(join(this.directory, "providers.json"), true)).value.providers || []
      const saved = providers.find(provider => provider.id === item.id)
      if (!saved || saved.off || !saved.key) continue
      const catalog = await this.host.readProviderCatalog(item.id)
      if (catalog.models.some(model => model.id === "gpt-image-2" && model.draws === true)) return item.id + "/gpt-image-2"
    }
    throw new Error("Magpie 尚未获取到可用的 NovaFlow gpt-image-2 生图模型，请先点击立即同步或在 Magpie 供应商页面获取模型")
  }

  async apply() {
    const marker = this.markerStore.read()
    marker.fields ||= {}
    const tasks = [
      ["mcp", () => this.imageMCP()],
      ["imageGen", async () => {
        const reference = await this.imageReference()
        await this.editSetting("imageGen", reference)
        return "已选择 NovaFlow / gpt-image-2"
      }],
      ["updateChannel", async () => { await this.editSetting("updateChannel", "stable"); return "已设置为稳定版" }],
    ]
    marker.status = "running"
    this.markerStore.write(marker)
    for (const [id, task] of tasks) {
      try { marker.fields[id] = { status: "success", message: await task(), ...(id === "imageGen" ? { hostValidated: true } : {}) } }
      catch (error) { marker.fields[id] = { status: "failed", message: error.message } }
      marker.updatedAt = new Date().toISOString()
      this.markerStore.write(marker)
    }
    marker.status = tasks.every(([id]) => marker.fields[id]?.status === "success") ? "complete" : "partial_failure"
    this.markerStore.write(marker)
    return this.status()
  }
}
