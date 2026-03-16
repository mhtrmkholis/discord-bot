import { spawn } from "node:child_process"
import fetch from "node-fetch"

const AI_PROVIDER = (process.env.AI_PROVIDER || "copilot").toLowerCase()
const COPILOT_MODEL = (process.env.COPILOT_MODEL || "").trim()
const COPILOT_RETRIES = Number(process.env.COPILOT_RETRIES || 2)
const COPILOT_TIMEOUT_MS = Number(process.env.COPILOT_TIMEOUT_MS || 120_000)
const COPILOT_MAX_PROMPT_CHARS = Number(process.env.COPILOT_MAX_PROMPT_CHARS || 50_000)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetriableCopilotError(err) {
  const msg = String(err?.message || "").toLowerCase()
  const code = String(err?.code || "").toUpperCase()
  return code === "EPIPE" || code === "ETIMEDOUT" || msg.includes("epipe") || msg.includes("timed out")
}

// ---- Copilot CLI provider ----

function callCopilotOnce(prompt, model) {
  return new Promise((resolve, reject) => {
    const ghPath = process.env.GH_PATH || "gh"
    const safePrompt = String(prompt || "").slice(0, COPILOT_MAX_PROMPT_CHARS)
    const args = ["copilot", "-p", safePrompt, "--allow-all-tools", "--silent"]
    const useModel = model || COPILOT_MODEL
    if (useModel) {
      args.push("--model", useModel)
    }

    const child = spawn(ghPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    let sawStdinEpipe = false

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // Ignore kill failures
      }
      const err = new Error(`gh copilot timed out after ${COPILOT_TIMEOUT_MS}ms`)
      err.code = "ETIMEDOUT"
      finish(err)
    }, COPILOT_TIMEOUT_MS)

    child.stdout.on("data", (d) => { stdout += d })
    child.stderr.on("data", (d) => { stderr += d })

    const finish = (err, code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (err) return reject(err)
      if (code !== 0) {
        const error = new Error(stderr || `gh exited with code ${code}`)
        if (sawStdinEpipe) error.code = "EPIPE"
        return reject(error)
      }
      // Strip the stats block that Copilot appends
      const clean = stdout.replace(/\n*Total usage est:[\s\S]*$/, "").trim()
      resolve(clean)
    }

    child.on("error", (err) => finish(err))
    child.on("close", (code) => finish(null, code))

    // No stdin write: prompt is passed as an argument to `-p`.
    if (child.stdin) {
      child.stdin.on("error", (err) => {
        if (err?.code === "EPIPE") {
          sawStdinEpipe = true
          return
        }
        finish(err)
      })
      child.stdin.end()
    }
  })
}

async function callCopilot(prompt, model) {
  let lastErr
  for (let attempt = 0; attempt <= COPILOT_RETRIES; attempt += 1) {
    try {
      return await callCopilotOnce(prompt, model)
    } catch (err) {
      lastErr = err
      if (!isRetriableCopilotError(err) || attempt === COPILOT_RETRIES) {
        throw err
      }
      await sleep(500 * (attempt + 1))
    }
  }
  throw lastErr
}

// ---- Ollama provider ----

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434"

async function callOllama(prompt, system, model) {
  model = model || process.env.OLLAMA_MODEL || "qwen2.5-coder:14b"
  const messages = []
  if (system) messages.push({ role: "system", content: system })
  messages.push({ role: "user", content: prompt })

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: 0.1, num_predict: -1 },
    }),
  })
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return (data.message?.content || "").trim()
}

// ---- Public API ----

const COPILOT_LIGHT_MODEL = (process.env.COPILOT_LIGHT_MODEL || "gpt-4o-mini").trim()
const OLLAMA_LIGHT_MODEL = (process.env.OLLAMA_LIGHT_MODEL || "qwen2.5-coder:7b").trim()

/**
 * Call the configured AI provider.
 * @param {string} prompt — the user/task prompt
 * @param {string} [system] — optional system prompt (used as separate system message for Ollama)
 * @param {{ light?: boolean }} [options] — if light=true, use a smaller/free model
 */
export async function callAI(prompt, system, options = {}) {
  const lightModel = options.light
    ? (AI_PROVIDER === "copilot" ? COPILOT_LIGHT_MODEL : OLLAMA_LIGHT_MODEL)
    : undefined
  if (AI_PROVIDER === "copilot") {
    const full = system ? system + "\n\n" + prompt : prompt
    return callCopilot(full, lightModel)
  }
  return callOllama(prompt, system, lightModel)
}

/** Return the light model name for display purposes */
export function getLightModelName() {
  return AI_PROVIDER === "copilot" ? COPILOT_LIGHT_MODEL : OLLAMA_LIGHT_MODEL
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
