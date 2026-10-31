import { createHash } from "node:crypto"
import { unzipSync, deflateRawSync, inflateRawSync } from "node:zlib"

const MAX_FILES = 2_000
const MAX_EXPANDED = 64 << 20
const MAX_COMPRESSION_RATIO = 100

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let x = i
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1
    table[i] = x >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function normalizeZipPath(raw) {
  const path = String(raw ?? "")
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error("Skill package path is invalid")
  }
  const parts = path.split("/")
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Skill package path is invalid")
  return path
}

export function parseZip(bytes) {
  const buffer = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(String(bytes))
  if (buffer.length < 22) throw new Error("Invalid skill package")
  let end = -1
  const start = Math.max(0, buffer.length - 66_000)
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error("Invalid skill package")
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  if (count === 0xffff || offset === 0xffffffff) throw new Error("Zip64 skill packages are not supported")
  const entries = []
  let expanded = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid skill package")
    const centralOffset = offset
    const versionMade = buffer.readUInt16LE(offset + 8)
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const external = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameEnd = offset + 46 + nameLength
    const name = buffer.subarray(offset + 46, nameEnd).toString("utf8")
    offset = nameEnd + extraLength + commentLength
    if ((versionMade >>> 8) === 3 && ((external >>> 16) & 0o170000) === 0o120000) throw new Error("Skill package contains a symbolic link")
    if (flags & 0x0001) throw new Error("Encrypted skill packages are not supported")
    if (method !== 0 && method !== 8) throw new Error("Skill package uses an unsupported compression method")
    expanded += uncompressedSize
    if (entries.length >= MAX_FILES || expanded > MAX_EXPANDED) throw new Error("Skill package expands beyond its limits")
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid skill package")
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error("Invalid skill package")
    const raw = buffer.subarray(dataStart, dataEnd)
    let content
    try {
      content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    } catch (cause) {
      throw new Error("Invalid skill package", { cause })
    }
    if (content.length !== uncompressedSize) throw new Error("Skill package manifest mismatch")
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new Error("Skill package exceeds the compression ratio limit")
    }
    if (crc32(content) !== buffer.readUInt32LE(centralOffset + 16)) {
      throw new Error("Skill package CRC mismatch")
    }
    if (name.endsWith("/")) continue
    entries.push({ path: normalizeZipPath(name), bytes: content })
  }
  const seen = new Map()
  for (const entry of entries) {
    const lowered = entry.path.toLowerCase()
    if (seen.has(lowered)) throw new Error("Skill package contains a case-insensitive path collision")
    seen.set(lowered, entry.path)
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export function createZip(files) {
  const normalized = [...files]
    .map((file) => ({ path: normalizeZipPath(file.path), bytes: Buffer.from(file.bytes ?? "") }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const file of normalized) {
    const name = Buffer.from(file.path, "utf8")
    const compressed = deflateRawSync(file.bytes, { level: 9 })
    const method = compressed.length < file.bytes.length ? 8 : 0
    const stored = method === 8 ? compressed : file.bytes
    const crc = crc32(file.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(file.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, stored)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(file.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + stored.length
  }
  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(normalized.length, 8)
  end.writeUInt16LE(normalized.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, end])
}

export function effectivePath(path, entries) {
  const first = String(path ?? "").split("/")[0]
  const allUnderOne = entries.length > 0 && entries.every((entry) => entry.path.startsWith(first + "/"))
  if (!allUnderOne) return path
  const hasRootSkill = entries.some((entry) => entry.path === "SKILL.md")
  return hasRootSkill ? path : path.slice(first.length + 1)
}

export function validatePackageEntries(entries) {
  if (!entries.length) throw new Error("Skill package is empty")
  const normalized = entries.map((entry) => ({ ...entry, path: effectivePath(entry.path, entries) }))
  const rootSkills = normalized.filter((entry) => entry.path === "SKILL.md")
  if (rootSkills.length !== 1) throw new Error("Skill package needs exactly one root SKILL.md")
  const seen = new Set()
  for (const entry of normalized) {
    if (seen.has(entry.path.toLowerCase())) throw new Error("Skill package contains a case-insensitive path collision")
    seen.add(entry.path.toLowerCase())
  }
  return normalized.sort((a, b) => {
    if (a.path === "SKILL.md") return -1
    if (b.path === "SKILL.md") return 1
    return a.path.localeCompare(b.path)
  })
}

export function manifestFor(entries) {
  return validatePackageEntries(entries).map((entry) => ({
    path: entry.path,
    size: entry.bytes.length,
    sha256: createHash("sha256").update(entry.bytes).digest("hex"),
  }))
}

export function hashSkillManifest(manifest) {
  const rows = manifest.map(file => [file.path, file.sha256]).sort((a, b) => {
    if (a[0] === b[0]) return 0
    if (a[0] === "SKILL.md") return -1
    if (b[0] === "SKILL.md") return 1
    return a[0].localeCompare(b[0])
  })
  return "sha256:" + createHash("sha256").update(JSON.stringify(rows)).digest("hex")
}

export async function verifyDownloadedPackage(bytes, { packageHash, manifest }) {
  const actual = "sha256:" + createHash("sha256").update(bytes).digest("hex")
  if (packageHash && packageHash !== actual) throw new Error("Skill package hash does not match")
  const entries = parseZip(bytes)
  const normalized = validatePackageEntries(entries)
  const generated = manifestFor(normalized)
  if (!Array.isArray(manifest) || manifest.length !== generated.length) throw new Error("Skill package manifest mismatch")
  for (let i = 0; i < generated.length; i++) {
    if (generated[i].path !== manifest[i]?.path || generated[i].size !== manifest[i]?.size || generated[i].sha256 !== manifest[i]?.sha256) {
      throw new Error("Skill package manifest mismatch")
    }
  }
  return { hash: actual, entries: normalized, manifest: generated }
}

export async function buildShareablePackage(sourceDirectory, fileReader) {
  const files = typeof fileReader === "function" ? await fileReader(sourceDirectory) : sourceDirectory
  const normalized = validatePackageEntries(files.files ?? files)
  return {
    bytes: createZip(normalized),
    manifest: manifestFor(normalized),
    excluded: files.excluded ?? [],
  }
}

export { unzipSync }
