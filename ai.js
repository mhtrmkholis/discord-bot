import { execFile } from "node:child_process"
import fetch from "node-fetch"

const AI_PROVIDER = (process.env.AI_PROVIDER || "copilot").toLowerCase()
const COPILOT_MODEL = (process.env.COPILOT_MODEL || "").trim()

// ---- Copilot CLI provider ----

function callCopilot(prompt) {
  return new Promise((resolve, reject) => {
    const ghPath = process.env.GH_PATH || "gh"
    const args = ["copilot", "-p", prompt, "--allow-all-tools"]
    if (COPILOT_MODEL) {
      args.push("--model", COPILOT_MODEL)
    }

    execFile(ghPath, args, {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message))
      // Strip the stats block that Copilot appends
      const clean = stdout.replace(/\n*Total usage est:[\s\S]*$/, "").trim()
      resolve(clean)
    })
  })
}

// ---- Ollama provider ----

async function callOllama(prompt) {
  const model = process.env.OLLAMA_MODEL || "qwen2.5-coder:14b"
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  })
  const data = await res.json()
  return (data.response || "").trim()
}

// ---- Public API ----

export async function callAI(prompt) {
  if (AI_PROVIDER === "copilot") return callCopilot(prompt)
  return callOllama(prompt)
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
