import fetch from "node-fetch"

export async function callAI(prompt) {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5-coder:7b",
      prompt,
      stream: false,
    }),
  })
  const data = await res.json()
  return (data.response || "").trim()
}

export function extractCode(raw) {
  const fencedBlock = raw.match(/```([^\n`]*)\n([\s\S]*?)```/)
  const language = fencedBlock?.[1]?.trim() || ""
  const code = (fencedBlock?.[2] || raw).trim()
  return { language, code }
}

export function formatCodeReply(raw) {
  const { language, code } = extractCode(raw)
  const formatted = `\`\`\`${language}\n${code}\n\`\`\``
  return formatted.length > 1900 ? formatted.slice(0, 1900) : formatted
}
