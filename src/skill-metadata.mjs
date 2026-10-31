// Read only display metadata, never execute or interpret skill instructions.
// Magpie displays SKILL.md front matter with whitespace collapsed.
export function skillDescription(content) {
  const text = Buffer.from(content ?? "").toString("utf8").replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return ""
  const end = text.indexOf("\n---", 4)
  if (end < 0) return ""
  const lines = text.slice(4, end).split("\n")
  for (let index = 0; index < lines.length; index++) {
    const match = /^(?:description|"description"|'description'):\s*(.*)$/.exec(lines[index])
    if (!match) continue
    let value = match[1].trim()
    const following = []
    for (let next = index + 1; next < lines.length && (/^\s/.test(lines[next]) || !lines[next].trim()); next++) following.push(lines[next].trim())
    if (/^[>|][+-]?[1-9]?(?:\s+#.*)?$/.test(value)) value = following.join(" ")
    else {
      value = [value, ...following].join(" ").trim()
      if (value.startsWith('"')) {
        // Double quoted YAML accepts JSON's common escaped scalar forms.
        const quoted = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(value)
        if (!quoted) return ""
        try { value = JSON.parse(quoted[1]) } catch { return "" }
      } else if (value.startsWith("'")) {
        const quoted = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(value)
        if (!quoted) return ""
        value = quoted[1].replace(/''/g, "'")
      } else value = value.replace(/\s+#.*$/, "")
    }
    return value.replace(/\s+/g, " ").trim()
  }
  return ""
}
