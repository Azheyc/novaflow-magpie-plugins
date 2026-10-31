import { execFileSync } from "node:child_process"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Expected an explicit package version")
const origin = "https://www.ycnovaflow.vip"
const localRoot = join(root, ".local")
const outputName = `${pkg.name}-${pkg.version}-production`
const output = join(localRoot, outputName)
const staged = `${output}.new`

await mkdir(localRoot, { recursive: true })
await rm(staged, { recursive: true, force: true })
try {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8" }))
  if (!packed?.filename) throw new Error("npm pack did not return an archive")
  await mkdir(staged)
  execFileSync("tar", ["-xzf", join(root, packed.filename), "-C", staged, "--strip-components=1"])
  const config = await readFile(join(staged, "src/config.mjs"), "utf8")
  if (!config.includes(`export const PRODUCTION_ORIGIN = "${origin}"`) || /localhost:15173|127\.0\.0\.1:18080/.test(config)) {
    throw new Error("Refusing a production artifact with a development server origin")
  }
  await writeFile(join(staged, "production-build.json"), JSON.stringify({
    kind: "production", origin, package: pkg.name, version: pkg.version,
  }, null, 2) + "\n")
  await rm(output, { recursive: true, force: true })
  await rename(staged, output)
  execFileSync("tar", ["-czf", `${output}.tgz`, "-C", localRoot, outputName], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  process.stdout.write(output + "\n")
} finally {
  await rm(staged, { recursive: true, force: true })
}
