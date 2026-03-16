import { spawn } from "node:child_process"
import fetch from "node-fetch"

// ---- Config (read once at startup) ----

const AI_PROVIDER = (process.env.AI_PROVIDER || "copilot").toLowerCase()
const COPILOT_MODEL = (process.env.COPILOT_MODEL || "").trim()
const COPILOT_LIGHT_MODEL = (process.env.COPILOT_LIGHT_MODEL || "gpt-4o-mini").trim()
const COPILOT_RETRIES = Number(process.env.COPILOT_RETRIES || 2)
const COPILOT_TIMEOUT_MS = Number(process.env.COPILOT_TIMEOUT_MS || 120_000)
const COPILOT_MAX_PROMPT_CHARS = Number(process.env.COPILOT_MAX_PROMPT_CHARS || 50_000)

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434"
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || "qwen2.5-coder:14b").trim()
const OLLAMA_LIGHT_MODEL = (process.env.OLLAMA_LIGHT_MODEL || "qwen2.5-coder:7b").trim()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- Copilot CLI ----

function isRetriable(err) {
  const msg = String(err?.message || "").toLowerCase()
  const code = String(err?.code || "").toUpperCase()
  return code === "EPIPE" || code === "ETIMEDOUT" || msg.includes("epipe") || msg.includes("timed out")
}

function copilotOnce(prompt, model) {
  return new Promise((resolve, reject) => {
    const ghPath = process.env.GH_PATH || "gh"
    const safe = String(prompt || "").slice(0, COPILOT_MAX_PROMPT_CHARS)
    const args = ["copilot", "-p", safe, "--allow-all-tools", "--silent"]
    const m = model || COPILOT_MODEL
    if (m) args.push("--model", m)

    const child = spawn(ghPath, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = "", done = false, epipe = false

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch {}
      const e = new Error(`gh copilot timed out after ${COPILOT_TIMEOUT_MS}ms`)
      e.code = "ETIMEDOUT"
      fin(e)
    }, COPILOT_TIMEOUT_MS)

    child.stdout.on("data", (d) => { stdout += d })
    child.stderr.on("data", (d) => { stderr += d })

    const fin = (err, code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) return reject(err)
      if (code !== 0) {
        const e = new Error(stderr || `gh exited ${code}`)
        if (epipe) e.code = "EPIPE"
        return reject(e)
      }
      resolve(stdout.replace(/\n*Total usage est:[\s\S]*$/, "").trim())
    }

    child.on("error", fin)
    child.on("close", (c) => fin(null, c))
    if (child.stdin) {
      child.stdin.on("error", (e) => { if (e?.code === "EPIPE") { epipe = true; return } fin(e) })
      child.stdin.end()
    }
  })
}

async function copilot(prompt, model) {
  let last
  for (let i = 0; i <= COPILOT_RETRIES; i++) {
    try { return await copilotOnce(prompt, model) }
    catch (e) { last = e; if (!isRetriable(e) || i === COPILOT_RETRIES) throw e; await sleep(500 * (i + 1)) }
  }
  throw last
}

// ---- Ollama ----

async function ollama(prompt, system, model) {
  const msgs = []
  if (system) msgs.push({ role: "system", content: system })
  msgs.push({ role: "user", content: prompt })

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: msgs, stream: false, options: { temperature: 0.1, num_predict: -1 } }),
  })
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return (data.message?.content || "").trim()
}

// ---- Public API ----

/**
 * @param {string} prompt
 * @param {string} [system] — separate system message (Ollama uses roles; Copilot prepends)
 * @param {{ light?: boolean }} [opts]
 */
export async function callAI(prompt, system, opts = {}) {
  if (AI_PROVIDER === "copilot") {
    const full = system ? system + "\n\n" + prompt : prompt
    return copilot(full, opts.light ? COPILOT_LIGHT_MODEL : undefined)
  }
  return ollama(prompt, system, opts.light ? OLLAMA_LIGHT_MODEL : OLLAMA_MODEL)
}

export function getProviderInfo() {
  return {
    provider: AI_PROVIDER,
    model: AI_PROVIDER === "copilot" ? (COPILOT_MODEL || "(default)") : OLLAMA_MODEL,
    lightModel: AI_PROVIDER === "copilot" ? COPILOT_LIGHT_MODEL : OLLAMA_LIGHT_MODEL,
    retries: COPILOT_RETRIES,
    timeout: COPILOT_TIMEOUT_MS,
    maxPrompt: COPILOT_MAX_PROMPT_CHARS,
  }
}

export function extractCode(raw) {
  const m = raw.match(/```([^\n`]*)\n([\s\S]*?)```/)
  return { language: m?.[1]?.trim() || "", code: (m?.[2] || raw).trim() }
}
