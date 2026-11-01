import { execFile } from "node:child_process"
import { access, chmod, constants as fsConstants, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { PRODUCTION_ORIGIN } from "./config.mjs"
import { skillDescription } from "./skill-metadata.mjs"
import { manifestFor, hashSkillManifest } from "./skill-packages.mjs"

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/
const LIBRARY_SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/
const AGENT_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/

function runChild(exec, command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    exec(command, args, {
      encoding: "utf8",
      maxBuffer: 4 << 20,
      timeout: options.timeout ?? 15_000,
      env: options.env ?? process.env,
      signal: options.signal,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout ?? "")
        error.stderr = String(stderr ?? "")
        reject(error)
        return
      }
      resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
    })
  })
}

function isInside(root, candidate) {
  const relation = relative(resolve(root), resolve(candidate))
  return relation === "" || (!!relation && !relation.startsWith("..") && !relation.includes(sep + ".."))
}

function parseLibraryView(text) {
  const lines = String(text ?? "").split(/\r?\n/)
  const skills = []
  let insideSkills = false
  let libraryDir = ""
  for (const line of lines) {
    const kept = /^\s*kept in\s+(.+?)\s*$/.exec(line)
    if (kept) {
      // Magpie appends its help hint after the real path, for example:
      //   kept in /Users/example/.config/magpie/library · magpie library help
      // Keep only the directory before treating this as a filesystem path.
      libraryDir = kept[1].split(/\s+·\s+/, 1)[0].trim()
      insideSkills = false
      continue
    }
    if (/^Skills\s*$/.test(line)) {
      insideSkills = true
      continue
    }
    if (/^(?:MCP servers|Instructions|RTK)\b/.test(line)) insideSkills = false
    if (!insideSkills) continue
    const match = /^\s{2,}([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\s*(?:→|->)\s*(.+))?$/.exec(line)
    if (!match) continue
    const agents = match[2] && match[2].trim() !== "no agent"
      ? match[2].split(/[,，]\s*/).map((item) => item.trim()).filter(Boolean)
      : []
    skills.push({ name: match[1], agents })
  }
  return { skills, libraryDir }
}

function normalizeAgentList(value) {
  if (value === "all") return "all"
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const agent = String(item ?? "").trim()
    if (agent && !AGENT_RE.test(agent)) throw new Error("Invalid Magpie agent identifier")
    if (agent && !out.includes(agent)) out.push(agent)
  }
  return out.slice(0, 32)
}

export class MagpieHostAdapter {
  constructor({
    magpiePath = "",
    execImpl = execFile,
    env = process.env,
    platform = process.platform,
    directory = "",
    sharedSkillsDir,
    home = homedir(),
    now = () => new Date(),
  } = {}) {
    this.magpiePath = magpiePath
    this.execImpl = execImpl
    this.env = env
    this.platform = platform
    this.directory = directory
    this.home = home
    this.sharedSkillsDir = sharedSkillsDir || join(home, ".agents", "skills")
    this.now = now
    this.available = false
    this.version = ""
    this.lastError = ""
  }

  static async detect({ platform = process.platform, env = process.env, paths = [], directory = "" } = {}) {
    // Even `magpie --version` loads provider plugins. Discover files only;
    // executing Magpie here would recursively initialize this plugin.
    const configured = [
      env.MAGPIE_CLI_PATH,
      env.MAGPIE_BIN,
      ...paths,
      platform === "darwin" ? "/Applications/magpie.app/Contents/MacOS/magpie" : "",
      platform === "win32" ? join(env.LOCALAPPDATA ?? "", "Programs", "magpie", "magpie.exe") : "",
    ].filter(Boolean)
    const searchPaths = String(env.PATH || "").split(platform === "win32" ? ";" : delimiter).filter(Boolean)
    const executable = platform === "win32" ? "magpie.exe" : "magpie"
    const candidates = configured.flatMap((candidate) => isAbsolute(candidate)
      ? [candidate]
      : searchPaths.map((path) => join(path, candidate)))
    candidates.push(...searchPaths.map((path) => join(path, executable)))
    for (const candidate of new Set(candidates)) {
      try {
        await access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
        if (!(await stat(candidate)).isFile()) continue
        let version = ""
        if (platform === "darwin") {
          // Magpie's app bundle ships an XML plist. Unsupported metadata
          // formats leave the version unknown, never trigger a CLI fallback.
          const plist = await readFile(join(dirname(candidate), "..", "Info.plist"), "utf8").catch(() => "")
          version = /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+\.\d+\.\d+)<\/string>/.exec(plist)?.[1] || ""
        }
        if (!version && directory) {
          const saved = await readFile(join(directory, "last-version"), "utf8").catch(() => "")
          version = /^(?:magpie\s+)?(\d+\.\d+\.\d+)\s*$/.exec(saved)?.[1] || ""
        }
        return { magpiePath: candidate, version }
      } catch {}
    }
    return { magpiePath: "", version: "" }
  }

  async run(args, options = {}) {
    if (this.env.NOVAFLOW_PLUGIN_CLI_CHILD === "1") throw new Error("Nested NovaFlow CLI calls are disabled")
    if (!this.magpiePath) throw new Error("Magpie CLI is unavailable")
    return runChild(this.execImpl, this.magpiePath, args, {
      ...options,
      // Magpie loads providers for Library commands too. The entry point
      // returns no hooks in this child, so no service or sync can start.
      env: { ...this.env, ...options.env, NOVAFLOW_PLUGIN_CLI_CHILD: "1" },
    })
  }

  async initialize() {
    const detected = await MagpieHostAdapter.detect({
      platform: this.platform,
      env: this.env,
      paths: this.magpiePath ? [this.magpiePath] : [],
      directory: this.directory,
    })
    this.magpiePath = detected.magpiePath
    this.version = detected.version
    this.available = !!this.magpiePath
    this.lastError = this.available ? "" : "Magpie CLI is unavailable"
    return this.available
  }

  async openWebsite() {
    // Sandboxed plugin pages cannot open popups. This command has no caller
    // URL: it can only open the build's fixed NovaFlow website.
    const command = this.platform === "darwin" ? "/usr/bin/open" : this.platform === "win32" ? "rundll32.exe" : "xdg-open"
    const args = this.platform === "win32" ? ["url.dll,FileProtocolHandler", PRODUCTION_ORIGIN] : [PRODUCTION_ORIGIN]
    await runChild(this.execImpl, command, args, { env: this.env, timeout: 5_000 })
  }

  async openEnterpriseGuide() {
    const command = this.platform === "darwin" ? "/usr/bin/open" : this.platform === "win32" ? "rundll32.exe" : "xdg-open"
    const target = PRODUCTION_ORIGIN + "/profile"
    const args = this.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target]
    await runChild(this.execImpl, command, args, { env: this.env, timeout: 5_000 })
  }

  async refreshProvider(id, signal) {
    if (!/^novaflow-key-[a-f0-9]{20}$/.test(id)) throw new Error("Invalid managed provider identifier")
    if (!this.available) await this.initialize()
    if (!this.available) throw new Error("Magpie CLI is unavailable")
    await this.run(["provider", "refresh", id], { timeout: 45_000, signal })
  }

  providerCacheDirectory() {
    const configBase = isAbsolute(this.env.XDG_CONFIG_HOME || "") ? this.env.XDG_CONFIG_HOME : join(this.home, ".config")
    // A portable Magpie puts both configuration and cache beneath its data folder.
    if (resolve(this.directory) !== resolve(join(configBase, "magpie"))) return join(this.directory, "cache", "models")
    const cacheBase = isAbsolute(this.env.XDG_CACHE_HOME || "") ? this.env.XDG_CACHE_HOME : join(this.home, ".cache")
    return join(cacheBase, "magpie", "models")
  }

  async readProviderCatalog(id) {
    if (!/^novaflow-key-[a-f0-9]{20}$/.test(id)) throw new Error("Invalid managed provider identifier")
    const path = join(this.providerCacheDirectory(), id + ".json")
    let cached
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid model cache")
      cached = JSON.parse(await readFile(path, "utf8"))
      if (!Array.isArray(cached.models)) throw new Error("Invalid model cache")
    } catch (error) {
      if (error.code === "ENOENT") return { models: [] }
      throw new Error("Magpie model cache is unavailable")
    }
    return { models: cached.models.filter(model => typeof model.ID === "string").map(model => ({
      id: model.ID, name: String(model.Name || model.ID), draws: model.Draws === true,
    })) }
  }

  async library() {
    if (!this.available) await this.initialize()
    if (!this.available) throw new Error(this.lastError || "Magpie Library is unavailable")
    const result = await this.run(["library"])
    const parsed = parseLibraryView(result.stdout)
    if (!parsed.libraryDir) throw new Error("Magpie Library did not report its directory")
    return parsed
  }

  async listSkills() {
    const view = await this.library()
    const libraryDir = await realpath(view.libraryDir)
    const skillsRoot = join(libraryDir, "skills")
    const rootInfo = await lstat(skillsRoot).catch(() => null)
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
      return { skills: [], libraryAvailable: true, source: "magpie-cli" }
    }
    const skills = []
    for (const item of view.skills) {
      if (!LIBRARY_SKILL_RE.test(item.name)) continue
      const path = join(skillsRoot, item.name)
      let info
      try {
        const [link, directory] = await Promise.all([lstat(path), stat(path)])
        if (!directory.isDirectory() || link.isSymbolicLink() || !isInside(skillsRoot, path)) continue
        info = directory
      } catch {
        continue
      }
      let description = ""
      let entry
      try {
        entry = await open(join(path, "SKILL.md"), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
        const meta = await entry.stat()
        if (meta.isFile() && meta.size <= (2 << 20)) description = skillDescription(await entry.readFile())
      } catch {} finally { await entry?.close() }
      skills.push({
        name: item.name,
        description,
        agents: item.agents,
        source: "magpie-library",
        status: "registered",
        modifiedAt: info.mtime.toISOString(),
      })
    }
    return { skills, libraryAvailable: true, source: "magpie-cli" }
  }

  async listAgents() {
    if (!this.available) await this.initialize()
    if (!this.available) throw new Error(this.lastError || "Magpie CLI is unavailable")
    const result = await this.run(["agents"], { timeout: 20_000 })
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && AGENT_RE.test(line)).slice(0, 64)
  }

  async readSkillFiles(name) {
    const view = await this.library()
    if (!LIBRARY_SKILL_RE.test(name)) throw new Error("Invalid skill name")
    if (!view.skills.some((item) => item.name === name)) throw new Error("Skill is not registered in Magpie Library")
    const libraryDir = await realpath(view.libraryDir)
    const skillsRoot = join(libraryDir, "skills")
    const skillsInfo = await lstat(skillsRoot)
    if (!skillsInfo.isDirectory() || skillsInfo.isSymbolicLink()) throw new Error("Magpie Library skills folder is not a regular directory")
    const root = join(skillsRoot, name)
    const link = await lstat(root)
    if (link.isSymbolicLink() || !isInside(skillsRoot, root)) throw new Error("Skill is not a regular library folder")
    const found = []
    const seen = new Map()
    const excluded = []
    const EXCLUDE = /(^|[/\\])(?:\.git|node_modules|__pycache__|\.DS_Store|\.env(?:\.[^/\\]+)?|id_rsa|credentials(?:\.json)?|secrets\.ya?ml)$/i

    async function walk(directory, prefix) {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const absolute = join(directory, entry.name)
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) {
          excluded.push({ path, reason: "symlink" })
          continue
        }
        if (EXCLUDE.test(path)) {
          excluded.push({ path, reason: "secret-or-cache" })
          continue
        }
        if (entry.isDirectory()) {
          await walk(absolute, path)
          continue
        }
        if (!entry.isFile()) continue
        if (found.length >= 2_000) throw new Error("Skill contains too many files")
        const bytes = await readFile(absolute)
        if (bytes.byteLength > 64 << 20) throw new Error("Skill file is too large")
        const lowered = path.toLowerCase()
        if (seen.has(lowered)) throw new Error("Skill contains a case-insensitive path collision")
        seen.set(lowered, path)
        found.push({ path, bytes })
      }
    }
    await walk(root, "")
    found.sort((a, b) => {
      if (a.path === "SKILL.md") return -1
      if (b.path === "SKILL.md") return 1
      return a.path.localeCompare(b.path)
    })
    return { files: found, excluded }
  }

  async registerSkill({ name, sourceDir, agents = [], packageFiles = [], manifestHash = "", replaceExisting = false }) {
    if (!ALIAS_RE.test(name)) throw new Error("Invalid managed skill alias")
    const targetAgents = normalizeAgentList(agents)
    await mkdir(this.sharedSkillsDir, { recursive: true, mode: 0o700 })
    const staged = join(this.sharedSkillsDir, `.novaflow-${name}-${process.pid}-${Date.now()}`)
    const destination = join(this.sharedSkillsDir, name)
    let moved = false
    let previous = null
    let phase = "stage"
    try {
      await copyTree(sourceDir, staged)
      phase = "verify"
      const verified = await packageFilesFromDirectory(staged)
      if (manifestHash && await hashPackageFiles(verified) !== manifestHash) throw new Error("Staged skill does not match the verified package")
      phase = "host"
      if (!this.available) await this.initialize()
      if (!this.available) throw new Error(this.lastError || "Magpie CLI is unavailable")
      phase = "conflict"
      const view = await this.library()
      const libraryPath = join(await realpath(view.libraryDir), "skills", name)
      const exists = async path => {
        try { await lstat(path); return true } catch (error) { if (error?.code === "ENOENT") return false; throw error }
      }
      if (!replaceExisting && (view.skills.some(item => item.name.toLowerCase() === name.toLowerCase()) || await exists(libraryPath) || await exists(destination))) {
        throw new Error("Skill name is already in use")
      }
      phase = "stage"
      try {
        await stat(destination)
        previous = destination + `.novaflow-previous-${this.now().toISOString().replace(/[:.]/g, "-")}`
        await rename(destination, previous)
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
      }
      await rename(staged, destination)
      moved = true
      phase = "handover"
      await this.run(["library", "skill", "hand-over", name], { timeout: 60_000 })
      if (targetAgents.length) {
        await this.run(["library", "skill", "agents", name, targetAgents.join(",")], { timeout: 60_000 })
      }
      phase = "sync"
      await this.run(["library", "sync"], { timeout: 60_000 })
      phase = "confirm"
      const listed = await this.listSkills()
      const registered = listed.skills.some((item) => item.name === name)
      if (!registered) throw new Error("Magpie Library did not report the registered alias")
      if (previous) await rm(previous, { recursive: true, force: true })
      return { downloaded: true, registered, agents: registered ? targetAgents : [], available: false }
    } catch (error) {
      if (moved && !previous) await rm(destination, { recursive: true, force: true })
      if (previous) await rename(previous, destination).catch(() => {})
      const messages = {
        stage: "无法准备技能文件，请检查本机技能目录的写入权限和磁盘空间",
        verify: "技能复制后校验未通过，请重新下载安装",
        host: "Magpie 资料库命令不可用，请确认客户端安装完整",
        conflict: "本机已有同名技能，请先在 Magpie 资料库处理同名项后重试；原技能未被覆盖",
        handover: "Magpie 接管技能失败，请检查资料库状态后重试",
        sync: "技能已接管，但 Magpie 资料库同步失败，请重试安装",
        confirm: "Magpie 资料库尚未返回该技能的登记记录，请刷新后重试",
      }
      throw Object.assign(new Error(messages[phase], { cause: error }), { code: `HOST_SKILL_${phase.toUpperCase()}_FAILED`, libraryNameOwned: moved })
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {})
    }
  }

  async removeSkill(name) {
    if (!ALIAS_RE.test(name)) throw new Error("Invalid managed skill alias")
    const listed = await this.listSkills()
    if (!listed.skills.some((item) => item.name === name)) return { registered: false }
    if (!this.available) await this.initialize()
    if (!this.available) throw new Error(this.lastError || "Magpie CLI is unavailable")
    await this.run(["library", "skill", "rm", name], { timeout: 60_000 })
    const after = await this.listSkills()
    return { registered: after.skills.some((item) => item.name === name) }
  }
}

export class UnsupportedHostSettingsAdapter {
  constructor() {
    this.name = "unsupported"
    this.capability = "global-settings"
    this.available = false
  }

  async read() {
    throw Object.assign(new Error("Magpie does not expose a supported global settings field to plugins"), { code: "HOST_SETTINGS_UNSUPPORTED" })
  }

  async write() {
    throw Object.assign(new Error("Magpie does not expose a supported global settings field to plugins"), { code: "HOST_SETTINGS_UNSUPPORTED" })
  }
}

async function packageFilesFromDirectory(root) {
  const out = []
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error("Package contains a symbolic link")
      if (entry.isDirectory()) await walk(absolute, path)
      else if (entry.isFile()) out.push({ path, bytes: await readFile(absolute) })
    }
  }
  await walk(root, "")
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

async function copyTree(source, target) {
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  const entries = await readdir(source, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) throw new Error("Package contains a symbolic link")
    if (info.isDirectory()) await copyTree(from, to)
    else if (info.isFile()) {
      await writeFile(to, await readFile(from), { mode: 0o600 })
    }
  }
}

async function hashPackageFiles(files) {
  return hashSkillManifest(manifestFor(files))
}

export { ALIAS_RE, LIBRARY_SKILL_RE, parseLibraryView, runChild }
