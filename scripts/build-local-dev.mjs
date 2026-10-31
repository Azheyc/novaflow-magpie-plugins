import { execFileSync } from "node:child_process"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const localRoot = join(repoRoot, ".local")
const sourcePackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"))
if (!/^\d+\.\d+\.\d+$/.test(sourcePackage.version)) throw new Error("Expected an explicit major.minor.patch package version")
const artifact = process.env.NOVAFLOW_DEV_ARTIFACT ?? "default"
const artifactNames = {
  default: "novaflow-magpie-plugins-dev",
  stock: "novaflow-magpie-plugins-stock-dev",
  "stock-v5": "novaflow-magpie-plugins-stock-v5-dev",
  "stock-skills": "novaflow-magpie-plugins-stock-skills-dev",
  "stock-company": "novaflow-magpie-plugins-stock-company-dev",
  "stock-theme": "novaflow-magpie-plugins-stock-theme-dev",
}
const outputName = artifactNames[artifact]
if (!outputName) throw new Error("NOVAFLOW_DEV_ARTIFACT must be default, stock, stock-v5, stock-skills, stock-theme, or stock-company")
const versionedName = outputName.replace(/-dev$/, `-${sourcePackage.version}-dev`)
const output = join(localRoot, versionedName)
const staged = `${output}.new`
const packDirectory = join(localRoot, "dev-pack")
const localOrigin = "http://localhost:15173"
const productionLine = 'export const PRODUCTION_ORIGIN = "https://www.ycnovaflow.vip"'
const developmentLine = `export const PRODUCTION_ORIGIN = "${localOrigin}"`

await rm(output, { recursive: true, force: true })
await rm(staged, { recursive: true, force: true })
await rm(packDirectory, { recursive: true, force: true })
await mkdir(packDirectory, { recursive: true })

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: repoRoot,
    encoding: "utf8",
  }))
  const archiveName = packed?.[0]?.filename
  if (!archiveName) throw new Error("npm pack did not return an archive filename")

  await mkdir(staged, { recursive: true })
  execFileSync("tar", ["-xzf", join(packDirectory, archiveName), "-C", staged, "--strip-components=1"], {
    cwd: repoRoot,
  })

  const configPath = join(staged, "src", "config.mjs")
  const config = await readFile(configPath, "utf8")
  const matches = config.split(productionLine).length - 1
  if (matches !== 1) throw new Error(`expected one production origin line, found ${matches}`)
  await writeFile(configPath, config.replace(productionLine, developmentLine))

  const pkg = JSON.parse(await readFile(join(staged, "package.json"), "utf8"))
  await writeFile(join(staged, "dev-build.json"), JSON.stringify({
    kind: "local-development",
    origin: localOrigin,
    package: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
  }, null, 2) + "\n")

  await rename(staged, output)
  execFileSync("tar", ["-czf", `${output}.tgz`, "-C", localRoot, versionedName], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  process.stdout.write(output + "\n")
} finally {
  await rm(staged, { recursive: true, force: true })
  await rm(packDirectory, { recursive: true, force: true })
}
