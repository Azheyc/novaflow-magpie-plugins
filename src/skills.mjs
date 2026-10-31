import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { buildShareablePackage, verifyDownloadedPackage, hashSkillManifest as manifestHash } from "./skill-packages.mjs"
import { JsonStore, randomId } from "./state-store.mjs"
import { LIBRARY_SKILL_RE } from "./host-adapter.mjs"
import { skillDescription } from "./skill-metadata.mjs"

function aliasFor(companyId, slug) {
  const name = String(slug ?? "")
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) throw new Error("Skill slug is invalid")
  return name
}

async function directoryHash(root) {
  const rows = []
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute, path)
      else if (entry.isFile()) rows.push([path, createHash("sha256").update(await readFile(absolute)).digest("hex")])
    }
  }
  await walk(root, "")
  return manifestHash(rows.map(([path, sha256]) => ({ path, sha256 })))
}

export class SkillManager {
  constructor({ dataDir, host, api, session, store, now = () => new Date() }) {
    this.host = host
    this.api = api
    this.session = session
    this.now = now
    this.root = join(dataDir, "company-skills")
    this.backups = join(dataDir, "skill-backups")
    this.store = store ?? new JsonStore(join(dataDir, "skill-registry.json"), { entries: {} })
    this.data = this.store.read()
    this.registry = this.data.entries ?? {}
    this.storeCatalog = this.data.store ?? null
    this.storeScope = this.data.storeScope ?? ""
  }

  projection() {
    return {
      entries: Object.entries(this.registry).map(([skillId, entry]) => ({
        skillId,
        sourceKind: entry.sourceKind || "company",
        slug: entry.slug,
        alias: entry.alias,
        version: entry.version,
        download: entry.download,
        registration: entry.registration,
        registrationError: entry.registrationError,
        availability: entry.availability,
        remoteAvailability: entry.remoteAvailability,
        displayName: entry.displayName,
        description: entry.description,
        publisher: entry.publisher,
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
        companyId: entry.companyId,
        updatedAt: entry.updatedAt,
      })),
      count: Object.keys(this.registry).length,
      catalog: this.storeScope === this.scope() ? this.catalogProjection ?? [] : [],
      store: this.storeScope === this.scope() ? this.storeCatalog : null,
    }
  }

  scope() {
    const identity = this.session.projection?.() ?? {}
    return [identity.userId, identity.accountMode, identity.company?.id].map((value) => String(value ?? "")).join(":")
  }

  persist() {
    this.data = { ...this.data, entries: this.registry, store: this.storeCatalog, storeScope: this.storeScope }
    this.store.write(this.data)
  }

  restoreCatalog(catalog) {
    this.catalogProjection = Array.isArray(catalog) ? catalog : []
  }

  restoreStore(store) {
    if (store && typeof store === "object") this.storeCatalog = store
  }

  async refreshStore(signal) {
    const generation = this.session.generation
    const scope = this.scope()
    if (scope !== this.storeScope) {
      this.storeCatalog = null
      this.catalogProjection = []
    }
    const store = await this.session.withAccess((access) => this.api.skillStore(access, signal), { signal })
    if (!store || store.schema_version !== 1 || !Array.isArray(store.recommended) || !Array.isArray(store.company)) {
      throw Object.assign(new Error("NovaFlow skill store response is invalid"), { code: "SKILL_STORE_INVALID" })
    }
    if (generation !== this.session.generation || scope !== this.scope()) throw new Error("Account changed while loading skills")
    this.storeScope = scope
    this.storeCatalog = { ...store, recommended: [], categories: Array.isArray(store.categories) ? store.categories : [] }
    await this.applyCatalog({ skills: store.company })
    return this.storeCatalog
  }

  async storeDetail({ sourceKind, skillId, signal } = {}) {
    const source = this.validSourceKind(sourceKind)
    const id = this.validSkillID(skillId)
    const detail = await this.session.withAccess(
      (access) => this.api.skillStoreDetail(access, source, id, signal),
      { signal },
    )
    if (!detail || detail.skill?.skill_id !== id || !Array.isArray(detail.versions)) {
      throw Object.assign(new Error("NovaFlow skill detail response is invalid"), { code: "SKILL_STORE_INVALID" })
    }
    return detail
  }

  async installFromStore({ sourceKind, skillId, targetAgents = [], signal } = {}) {
    const source = this.validSourceKind(sourceKind)
    const id = this.validSkillID(skillId)
    const generation = this.session.generation
    const detail = await this.storeDetail({ sourceKind: source, skillId: id, signal })
    const version = detail.versions.find((item) => Number(item.version) === Number(detail.skill.current_version))
    if (!version) throw Object.assign(new Error("The current skill version is unavailable"), { code: "SKILL_VERSION_NOT_FOUND" })
    const downloaded = await this.session.withAccess(
      (access) => this.api.downloadSkillStoreVersion(access, source, id, version.version, signal),
      { signal },
    )
    if (generation !== this.session.generation) throw new Error("Account changed while downloading skill")
    const aliasOwner = source === "platform" ? "platform" : this.session.projection().company?.id
    if (!aliasOwner) throw new Error("Company identity is unavailable")
    return this.install({
      skill: {
        ...detail.skill,
        company_id: aliasOwner,
      },
      version,
      packageBytes: downloaded.bytes,
      manifest: version.files,
      targetAgents,
      sourceKind: source,
    })
  }

  validSourceKind(value) {
    const source = String(value ?? "").trim().toLowerCase()
    if (source !== "platform" && source !== "company") throw new Error("Invalid skill store source")
    return source
  }

  validSkillID(value) {
    const id = String(value ?? "").trim()
    if (!/^skl_[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("Invalid skill id")
    return id
  }

  async ensureDirectories() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(this.backups, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    await chmod(this.backups, 0o700)
  }

  async install({ skill, version, packageBytes, manifest, targetAgents = [], sourceKind = "company" }) {
    await this.ensureDirectories()
    const companyId = String(skill.company_id ?? skill.companyId ?? "")
    const previous = this.registry[skill.skill_id]
    // Existing registrations retain their Agent references until explicitly
    // removed. Only fresh/reinstalled registrations adopt the unprefixed name.
    const owned = previous && (previous.sourceKind || "company") === sourceKind && (!previous.companyId || previous.companyId === companyId)
    const plainName = aliasFor(companyId, skill.slug)
    let alias = owned && previous.registration === "registered" ? previous.alias : plainName
    if (alias !== plainName && this.host.listSkills) {
      const listed = await this.host.listSkills()
      if (!Array.isArray(listed.skills) || listed.libraryAvailable === false) throw new Error("Magpie 资料库暂不可用，请稍后重试")
      if (!listed.skills.some(item => item.name === alias)) alias = plainName
    }
    if (Object.entries(this.registry).some(([id, entry]) => id !== skill.skill_id && entry.alias === alias && entry.registration === "registered")) {
      const listed = this.host.listSkills ? await this.host.listSkills() : null
      if (!listed || !Array.isArray(listed.skills) || listed.libraryAvailable === false || listed.skills.some(item => item.name.toLowerCase() === alias.toLowerCase())) {
        throw Object.assign(new Error("本机已有同名技能，请先在 Magpie 资料库处理同名项后重试"), { code: "SKILL_NAME_CONFLICT" })
      }
    }
    // Tenant/skill identity belongs in the private cache, never the Library name.
    const cacheName = owned ? previous.cacheName || previous.alias : `pkg-${createHash("sha256").update(JSON.stringify([sourceKind, companyId, skill.skill_id])).digest("hex")}`
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(cacheName)) throw new Error("Invalid skill cache name")
    const ownsLibraryName = !!owned && previous.alias === alias && previous.registration !== "removed" && (previous.registration === "registered" || previous.libraryNameOwned === true)
    const final = join(this.root, cacheName)
    const temporary = join(this.root, `.download-${alias}-${randomId(8)}`)
    const verified = await verifyDownloadedPackage(packageBytes, { packageHash: version.package_hash, manifest })
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    await chmod(temporary, 0o700)
    try {
      for (const file of verified.entries) {
        const target = join(temporary, file.path)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await chmod(dirname(target), 0o700)
        await writeFile(target, file.bytes, { mode: 0o600 })
      }
      let rollback = null
      let localCopyPreserved = false
      try {
        await stat(final)
        const oldHash = await directoryHash(final)
        const expected = this.registry[skill.skill_id]?.manifestHash
        localCopyPreserved = !!expected && oldHash !== expected
        rollback = join(this.root, `.previous-${alias}-${randomId(8)}`)
        await rename(final, rollback)
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
      }
      try {
        await rename(temporary, final)
        if (rollback) {
          if (localCopyPreserved) {
            const backup = join(this.backups, `${alias}-${this.now().toISOString().replace(/[:.]/g, "-")}`)
            await rename(rollback, backup)
          } else {
            await rm(rollback, { recursive: true, force: true })
          }
          rollback = null
        }
      } catch (error) {
        if (rollback) {
          await rm(final, { recursive: true, force: true }).catch(() => {})
          await rename(rollback, final).catch(() => {})
        }
        throw error
      }
      if (localCopyPreserved) this.registry[skill.skill_id] = { ...this.registry[skill.skill_id], localCopyPreserved: true }
      let registration = { registered: false }
      try {
        registration = await this.host.registerSkill({
          name: alias,
          sourceDir: final,
          agents: targetAgents,
          packageFiles: verified.entries,
          manifestHash: manifestHash(verified.manifest),
          replaceExisting: ownsLibraryName,
        })
      } catch (error) {
        // Host adapters expose bounded, stage-specific messages. Never project
        // a child process's stdout/stderr or arbitrary filesystem exception.
        const code = String(error?.code ?? "")
        registration.libraryNameOwned = error?.libraryNameOwned === true
        registration.error = /^HOST_SKILL_[A-Z_]+_FAILED$/.test(code)
          ? { code, message: error.message }
          : { code: "HOST_SKILL_REGISTRATION_FAILED", message: "Magpie 资料库登记失败，请检查资料库是否可用后重试" }
      }
      this.registry[skill.skill_id] = {
        ...this.registry[skill.skill_id],
        slug: skill.slug,
        displayName: skill.display_name,
        description: skill.description,
        publisher: skill.publisher,
        categoryId: skill.category_id,
        categoryName: skill.category_name,
        companyId: sourceKind === "company" ? String(skill.company_id ?? "") : "",
        remoteAvailability: "available",
        alias,
        cacheName,
        libraryNameOwned: registration.registered || ownsLibraryName || registration.libraryNameOwned === true,
        version: Number(version.version),
        manifest: verified.manifest,
        manifestHash: manifestHash(verified.manifest),
        packageHash: verified.hash,
        download: "installed",
        registration: registration.registered ? "registered" : "downloaded",
        registrationError: registration.registered ? null : registration.error || { code: "HOST_SKILL_CONFIRM_FAILED", message: "Magpie 资料库尚未返回该技能的登记记录" },
        availability: "unverified",
        sourceKind,
        targetAgents,
        updatedAt: this.now().toISOString(),
      }
      this.persist()
      return this.registry[skill.skill_id]
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }

  async applyCatalog({ skills = [], revision = "" } = {}) {
    this.catalogProjection = skills.map((skill) => ({
      skillId: skill.skill_id,
      slug: skill.slug,
      displayName: skill.display_name,
      description: skill.description,
      status: skill.status,
      currentVersion: skill.current_version,
      categoryId: skill.category_id,
      categoryName: skill.category_name,
      publisher: skill.publisher,
    }))
    // Catalog refresh never downloads packages or changes Magpie registrations.
    const companyId = String(this.session.projection?.().company?.id ?? "")
    for (const [skillId, entry] of Object.entries(this.registry)) {
      const platform = entry.sourceKind === "platform"
      const belongs = !entry.companyId || entry.companyId === companyId
      const remote = !platform && belongs ? skills.find((skill) => skill.skill_id === skillId) : null
      entry.remoteAvailability = remote && (!remote.status || remote.status === "published") ? "available" : "unavailable"
    }
    this.registryRevision = revision
    this.persist()
    return { installed: 0, unchanged: Object.keys(this.registry).length, removed: 0, failed: [] }
  }

  async share({ sourceName, display_name, description, category_id = "", updateSkillId, expectedVersion, idempotencyKey }) {
    if (updateSkillId && !/^skl_[A-Za-z0-9_-]+$/.test(updateSkillId)) throw new Error("Invalid skill id")
    if (!LIBRARY_SKILL_RE.test(String(sourceName ?? ""))) throw new Error("Invalid skill name")
    const source = await this.host.readSkillFiles(sourceName)
    const packaged = await buildShareablePackage(source)
    const form = new FormData()
    form.set("category_id", String(category_id ?? ""))
    form.set("package", new Blob([packaged.bytes], { type: "application/zip" }), `${sourceName}.zip`)
    form.set("idempotency_key", String(idempotencyKey || randomId(18)))
    if (updateSkillId) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("expected_version is required")
      form.set("expected_version", String(expectedVersion))
    }
    const metadataDescription = skillDescription((source.files ?? source).find(file => file.path === "SKILL.md")?.bytes)
    // Identity is generated by NovaFlow, independently of Library folder names.
    for (const [name, value] of Object.entries({ display_name, description: description ?? metadataDescription })) {
      if (value !== undefined && value !== "") form.set(name, String(value))
    }
    const result = await this.session.withAccess((access) => (
      updateSkillId
        ? this.api.updateSkill(access, updateSkillId, form)
        : this.api.contributeSkill(access, form)
    ))
    return { ...result, excluded: packaged.excluded, manifest: packaged.manifest }
  }

  async previewShare({ sourceName }) {
    if (!LIBRARY_SKILL_RE.test(String(sourceName ?? ""))) throw new Error("Invalid skill name")
    const source = await this.host.readSkillFiles(sourceName)
    const packaged = await buildShareablePackage(source)
    return {
      sourceName,
      description: skillDescription((source.files ?? source).find(file => file.path === "SKILL.md")?.bytes),
      packageHash: "sha256:" + createHash("sha256").update(packaged.bytes).digest("hex"),
      packageBytes: packaged.bytes.byteLength,
      expandedBytes: packaged.manifest.reduce((sum, file) => sum + Number(file.size || 0), 0),
      files: packaged.manifest,
      excluded: packaged.excluded,
    }
  }
}

export { aliasFor }
