import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

export function defaultDataDir(magpieDirectory) {
  if (typeof magpieDirectory !== "string" || !magpieDirectory) {
    throw new Error("Magpie did not provide input.directory for private plugin state")
  }
  return join(magpieDirectory, "plugin-data", "novaflow-magpie-plugin")
}

export function secureMkdir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try {
    chmodSync(path, 0o700)
  } catch {}
}

export function atomicWriteFile(path, data, mode = 0o600) {
  const target = resolve(path)
  secureMkdir(dirname(target))
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  let fd
  try {
    fd = openSync(temporary, "w", mode)
    writeFileSync(fd, data, { encoding: typeof data === "string" ? "utf8" : undefined })
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, target)
    try {
      const directory = openSync(dirname(target), "r")
      fsyncSync(directory)
      closeSync(directory)
    } catch {}
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export class JsonStore {
  constructor(path, defaults = {}) {
    this.path = path
    this.defaults = defaults
  }

  read() {
    try {
      return { ...structuredClone(this.defaults), ...JSON.parse(readFileSync(this.path, "utf8")) }
    } catch (error) {
      if (error?.code === "ENOENT") return structuredClone(this.defaults)
      throw error
    }
  }

  write(value) {
    atomicWriteFile(this.path, JSON.stringify(value, null, 2) + "\n", 0o600)
    try {
      chmodSync(this.path, 0o600)
    } catch {}
    return value
  }

  exists() {
    try {
      return statSync(this.path).isFile()
    } catch {
      return false
    }
  }
}

export function randomId(bytes = 18) {
  return randomBytes(bytes).toString("base64url")
}

export function stableId(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}
