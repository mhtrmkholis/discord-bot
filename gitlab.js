import { Gitlab } from "@gitbeaker/node"
import fetch from "node-fetch"
import https from "node:https"
import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"

// Keep-alive agent — reuses TLS connections across API requests
const keepAlive = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) }
const agent = (url) => new URL(url).protocol === "https:" ? keepAlive.https : keepAlive.http

const api = new Gitlab({
  host: process.env.GITLAB_HOST || "https://gitlab.com",
  token: process.env.GITLAB_TOKEN,
})

const LOCAL_REPO = process.env.LOCAL_REPO_PATH || ""

const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo"])
const IGNORED_FILES = new Set([".DS_Store"])
const SOURCE_EXTS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".vue", ".php", ".py", ".go",
  ".java", ".rb", ".yml", ".yaml", ".sql", ".html", ".css", ".scss",
])
const JUNK_PATH = /\/(dist|build|coverage|\.next|\.turbo|node_modules|__mocks__|\.jest-cache)\//

// ---- Cached file tree ----

const CACHE_TTL = 5 * 60_000  // 5 min
let _relPaths = null
let _fullPaths = null
let _fileSet = null
let _cacheTs = 0

async function walkLocal(root) {
  const rel = [], full = []
  const pfx = root.endsWith(path.sep) ? root : root + path.sep
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const dirs = []
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name) || IGNORED_FILES.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) dirs.push(walk(p))
      else if (e.isFile()) { full.push(p); rel.push(p.slice(pfx.length).split(path.sep).join("/")) }
    }
    if (dirs.length) await Promise.all(dirs)
  }
  await walk(root)
  return { rel, full }
}

async function fetchTree(projectId, ref = "main") {
  const host = process.env.GITLAB_HOST || "https://gitlab.com"
  const token = process.env.GITLAB_TOKEN
  const base = `${host}/api/v4/projects/${encodeURIComponent(projectId)}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100`
  const headers = { "PRIVATE-TOKEN": token }

  const fetchPage = async (p) => {
    const r = await fetch(`${base}&page=${p}`, { headers, agent })
    if (!r.ok) throw new Error(`GitLab tree page ${p}: ${r.status}`)
    return r.json()
  }

  // Page 1 → learn total pages
  const r1 = await fetch(`${base}&page=1`, { headers, agent })
  if (!r1.ok) throw new Error(`GitLab tree ${r1.status}: ${await r1.text()}`)
  const totalPages = Number(r1.headers.get("x-total-pages") || 1)
  const firstPage = await r1.json()

  const blobs = []
  for (const i of firstPage) if (i.type === "blob") blobs.push(i.path)

  // All remaining pages in parallel — keep-alive reuses TLS connections
  const promises = []
  for (let p = 2; p <= totalPages; p++) promises.push(fetchPage(p))
  const pages = await Promise.all(promises)
  for (const items of pages) for (const i of items) if (i.type === "blob") blobs.push(i.path)
  return blobs
}

export async function getCachedTree(projectId) {
  if (_relPaths && Date.now() - _cacheTs < CACHE_TTL) {
    return { relPaths: _relPaths, fullPaths: _fullPaths, fileSet: _fileSet }
  }
  if (LOCAL_REPO) {
    const { rel, full } = await walkLocal(LOCAL_REPO)
    _relPaths = rel; _fullPaths = full
  } else {
    _relPaths = await fetchTree(projectId)
    _fullPaths = null
  }
  _fileSet = new Set(_relPaths)
  _cacheTs = Date.now()
  return { relPaths: _relPaths, fullPaths: _fullPaths, fileSet: _fileSet }
}

/** Pre-warm the tree cache in background (call on bot startup) */
export function warmCache(projectId) {
  getCachedTree(projectId).then(({ relPaths }) => console.log(`Tree cache: ${relPaths.length} files`)).catch((e) => console.error("Tree cache warm failed:", e.message))
}

// ---- File I/O ----

// ---- File content cache (API mode) ----
const _contentCache = new Map()
const CONTENT_CACHE_TTL = 3 * 60_000
const CONTENT_CACHE_MAX = 200

export async function getFileContent(projectId, filePath, ref = "main") {
  if (LOCAL_REPO) return fs.readFile(path.join(LOCAL_REPO, filePath), "utf8")
  const key = `${projectId}:${ref}:${filePath}`
  const cached = _contentCache.get(key)
  if (cached && Date.now() - cached.ts < CONTENT_CACHE_TTL) return cached.data
  // Direct fetch with keep-alive instead of gitbeaker (reuses TLS connections)
  const host = process.env.GITLAB_HOST || "https://gitlab.com"
  const token = process.env.GITLAB_TOKEN
  const url = `${host}/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`
  const r = await fetch(url, { headers: { "PRIVATE-TOKEN": token }, agent })
  if (!r.ok) throw new Error(`GitLab file ${r.status}: ${filePath}`)
  const f = await r.json()
  const data = Buffer.from(f.content, "base64").toString("utf-8")
  if (_contentCache.size >= CONTENT_CACHE_MAX) {
    const oldest = _contentCache.keys().next().value
    _contentCache.delete(oldest)
  }
  _contentCache.set(key, { data, ts: Date.now() })
  return data
}

export async function listFiles(projectId, subpath = "", ref = "main") {
  if (!subpath) return (await getCachedTree(projectId)).relPaths
  if (LOCAL_REPO) return (await walkLocal(path.join(LOCAL_REPO, subpath))).rel
  const tree = await api.Repositories.tree(projectId, { path: subpath, ref, recursive: true })
  return tree.filter((i) => i.type === "blob").map((i) => i.path)
}

export async function fileExistsInRepo(filePath, projectId) {
  return (await getCachedTree(projectId)).fileSet.has(filePath)
}

// ---- Search helpers ----

/** Path-only candidate scoring (no I/O, instant from cache) */
export function scoreByPath(relPaths, terms) {
  if (!terms.length) return []
  // Single regex matches any term — avoids per-term loop
  const termRe = new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi")
  const out = []
  for (let i = 0; i < relPaths.length; i++) {
    const lc = relPaths[i].toLowerCase()
    const ext = path.extname(relPaths[i]).toLowerCase()
    if (!SOURCE_EXTS.has(ext) || JUNK_PATH.test("/" + lc)) continue
    const matches = lc.match(termRe)
    if (!matches) continue
    const hits = new Set(matches.map(m => m.toLowerCase())).size
    let bonus = 0
    if (ext === ".tsx" || ext === ".jsx" || ext === ".vue") bonus += 3
    if (/\/(test|__tests__)\/|\.test\.|\.spec\./.test(lc)) bonus -= 6
    if (/\/(types|interfaces)\/|\.d\.ts$/.test(lc)) bonus -= 4
    if (lc.includes("/api/")) bonus -= 3
    out.push({ idx: i, pathScore: hits * 5 + bonus })
  }
  out.sort((a, b) => b.pathScore - a.pathScore)
  return out
}

/** Read a file and score by content keyword overlap — returns null if irrelevant */
async function scoreFileContent(projectId, relPath, fullPath, terms, snippetLines, maxBytes) {
  try {
    const content = fullPath
      ? await fs.readFile(fullPath, "utf8")
      : await getFileContent(projectId, relPath)
    if (content.length > maxBytes) return null
    const lc = content.toLowerCase()
    const hits = terms.filter((t) => lc.includes(t)).length
    if (!hits) return null
    // Grab best snippet lines — scan first 800 lines
    const lines = content.split(/\r?\n/)
    const limit = Math.min(lines.length, 800)
    const termRe = new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi")
    const scored = []
    for (let i = 0; i < limit; i++) {
      const m = lines[i].match(termRe)
      if (m) scored.push({ score: new Set(m.map(x => x.toLowerCase())).size, text: lines[i].trim().slice(0, 200) })
    }
    scored.sort((a, b) => b.score - a.score)
    return { contentHits: hits, snippets: scored.slice(0, snippetLines).map((s) => s.text) }
  } catch { return null }
}

/**
 * Two-phase candidate search:
 * Phase 1 — score by PATH keywords (instant, cached)
 * Phase 2 — read top N files and score by CONTENT
 */
export async function findCandidateFiles(keywords, opts = {}) {
  const projectId = opts.projectId || process.env.GITLAB_PROJECT_ID
  const terms = [...new Set((keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean))]
  if (!terms.length) return []

  const maxResults = opts.maxResults ?? 15
  const maxScan = LOCAL_REPO ? (opts.maxScan ?? 500) : Math.min(opts.maxScan ?? 500, 60)
  const snippetLines = opts.snippetLines ?? 3
  const maxBytes = 200_000

  const { relPaths, fullPaths } = await getCachedTree(projectId)
  const pathScored = scoreByPath(relPaths, terms).slice(0, maxScan)

  // Phase 2: parallel content scoring — larger batches, early exit
  const BATCH = LOCAL_REPO ? 100 : 15
  const results = []
  for (let b = 0; b < pathScored.length; b += BATCH) {
    const batch = pathScored.slice(b, b + BATCH)
    const res = await Promise.all(batch.map(async ({ idx, pathScore }) => {
      const r = await scoreFileContent(projectId, relPaths[idx], fullPaths?.[idx], terms, snippetLines, maxBytes)
      if (!r) return null
      return { path: relPaths[idx], score: pathScore + r.contentHits * 3, snippets: r.snippets }
    }))
    for (const r of res) if (r) results.push(r)
    // Early exit: enough high-quality results found
    if (results.length >= maxResults * 2) break
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, maxResults)
}

/** Find files whose filename matches tokens in text (component/file references) */
export async function findReferencedFiles(text, { exclude = [], limit = 4, projectId } = {}) {
  projectId = projectId || process.env.GITLAB_PROJECT_ID
  const tokens = new Set()
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9]{3,})\b/g)) tokens.add(m[1].toLowerCase())
  for (const m of text.matchAll(/\b([a-z][a-z0-9]{4,})\b/g)) {
    if (/cell|table|form|modal|dialog|list|card|view|page|button|input|panel|tab/i.test(m[1])) tokens.add(m[1].toLowerCase())
  }
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*[-_][a-z0-9-_]{2,})\b/g)) tokens.add(m[1].toLowerCase())
  for (const m of text.matchAll(/["'`]([A-Za-z0-9._/-]+\.[a-z]{2,4})["'`]/g)) {
    const n = m[1].split("/").pop().replace(/\.[^.]+$/, "")
    if (n.length >= 3) tokens.add(n.toLowerCase())
  }
  if (!tokens.size) return []

  const excludeSet = new Set(exclude.map((p) => p.toLowerCase()))
  const { relPaths } = await getCachedTree(projectId)
  const matches = []
  for (const rp of relPaths) {
    if (excludeSet.has(rp.toLowerCase())) continue
    if (JUNK_PATH.test("/" + rp) || /\/__test__\/|\.test\.|\.spec\./i.test(rp)) continue
    if (!SOURCE_EXTS.has(path.extname(rp).toLowerCase())) continue
    const fn = rp.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase()
    for (const t of tokens) { if (fn === t || fn.includes(t)) { matches.push(rp); break } }
  }

  // Proximity sort: files near the target directory rank higher
  if (matches.length > 1 && exclude.length) {
    const tDir = exclude[0].includes("/") ? exclude[0].slice(0, exclude[0].lastIndexOf("/")).toLowerCase() : ""
    const tParts = tDir.split("/")
    matches.sort((a, b) => {
      const shared = (p) => { const pp = p.toLowerCase().split("/"); let s = 0; for (let i = 0; i < Math.min(pp.length, tParts.length); i++) { if (pp[i] === tParts[i]) s++; else break } return s }
      return shared(b) - shared(a)
    })
  }
  return matches.slice(0, limit)
}

/** Same-directory sibling files */
export async function getSiblingFiles(filePath, limit = 6, projectId) {
  projectId = projectId || process.env.GITLAB_PROJECT_ID
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ""
  const pfx = dir ? dir + "/" : ""
  const { relPaths } = await getCachedTree(projectId)
  const out = []
  for (const p of relPaths) {
    if (p === filePath || !p.startsWith(pfx) || p.slice(pfx.length).includes("/")) continue
    if (!SOURCE_EXTS.has(path.extname(p).toLowerCase())) continue
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

// ---- GitLab MR ----

export async function createMR({ projectId, branchName, codePath, codeContent, commitMessage = "AI bug fix", mrTitle = "AI Bug Fix", onStatus = () => {} }) {
  try { onStatus("Creating branch…"); await api.Branches.create(projectId, branchName, "main") }
  catch (e) { if (!/already exists/i.test(String(e.message || ""))) { onStatus(`Branch failed: ${e.message}`); throw e } }

  onStatus("Committing fix…")
  await api.Commits.create(projectId, branchName, commitMessage, [
    { action: "update", file_path: codePath, content: codeContent },
  ])

  onStatus("Opening MR…")
  const mr = await api.MergeRequests.create(projectId, branchName, "main", mrTitle, { remove_source_branch: true })
  return mr.web_url
}
