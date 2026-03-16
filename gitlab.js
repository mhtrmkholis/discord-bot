import { Gitlab } from "@gitbeaker/node"
import fs from "node:fs/promises"
import path from "node:path"

const GITLAB_HOST = process.env.GITLAB_HOST || "https://gitlab.com"

const api = new Gitlab({
  host: GITLAB_HOST,
  token: process.env.GITLAB_TOKEN,
})

const LOCAL_REPO = process.env.LOCAL_REPO_PATH || ""
const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo",
])
const IGNORED_FILES = new Set([".DS_Store"])
const SEARCHABLE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".vue", ".php", ".py", ".go", ".java", ".rb",
  ".yml", ".yaml", ".sql", ".html", ".css", ".scss",
])

// ---- Cached file tree (avoids re-walking 53k+ files per call) ----

const CACHE_TTL_MS = 60_000
let _cachedRelPaths = null   // string[] of posix-relative paths
let _cachedFullPaths = null  // string[] of absolute paths (same order, local only)
let _cachedSet = null        // Set<string> for O(1) includes
let _cacheTs = 0

async function walkLocalFiles(root) {
  const relPaths = []
  const fullPaths = []
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue
      if (IGNORED_FILES.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        fullPaths.push(full)
        relPaths.push(full.slice(rootPrefix.length).split(path.sep).join("/"))
      }
    }
  }
  await walk(root)
  return { relPaths, fullPaths }
}

/** Fetch the full recursive file tree from GitLab API (gitbeaker auto-paginates) */
async function fetchGitLabTree(projectId, ref = "main") {
  const tree = await api.Repositories.tree(projectId, {
    ref,
    recursive: true,
    per_page: 100,
  })
  return tree.filter((item) => item.type === "blob").map((item) => item.path)
}

async function getCachedTree(projectId) {
  if (_cachedRelPaths && Date.now() - _cacheTs < CACHE_TTL_MS) {
    return { relPaths: _cachedRelPaths, fullPaths: _cachedFullPaths, fileSet: _cachedSet }
  }
  if (LOCAL_REPO) {
    const { relPaths, fullPaths } = await walkLocalFiles(LOCAL_REPO)
    _cachedRelPaths = relPaths
    _cachedFullPaths = fullPaths
    _cachedSet = new Set(relPaths)
  } else {
    const relPaths = await fetchGitLabTree(projectId)
    _cachedRelPaths = relPaths
    _cachedFullPaths = null  // no local paths when using API
    _cachedSet = new Set(relPaths)
  }
  _cacheTs = Date.now()
  return { relPaths: _cachedRelPaths, fullPaths: _cachedFullPaths, fileSet: _cachedSet }
}

export async function getFileContent(projectId, filePath, ref = "main") {
  if (LOCAL_REPO) {
    return fs.readFile(path.join(LOCAL_REPO, filePath), "utf8")
  }
  const file = await api.RepositoryFiles.show(projectId, filePath, ref)
  return Buffer.from(file.content, "base64").toString("utf-8")
}

export async function listFiles(projectId, subpath = "", ref = "main") {
  if (LOCAL_REPO) {
    if (!subpath) {
      const { relPaths } = await getCachedTree(projectId)
      return relPaths
    }
    const root = path.join(LOCAL_REPO, subpath)
    const { relPaths } = await walkLocalFiles(root)
    return relPaths
  }
  // GitLab API — use cached tree for full listing, API for subpath
  if (!subpath) {
    const { relPaths } = await getCachedTree(projectId)
    return relPaths
  }
  const tree = await api.Repositories.tree(projectId, { path: subpath, ref, recursive: true })
  return tree.filter((item) => item.type === "blob").map((item) => item.path)
}

/** O(1) file-exists check against the cached tree */
export async function fileExistsInRepo(filePath, projectId) {
  const { fileSet } = await getCachedTree(projectId)
  return fileSet.has(filePath)
}

export async function searchLocalContent(keywords, options = {}) {
  const terms = [...new Set((keywords || []).map((k) => String(k || "").toLowerCase()).filter(Boolean))]
  if (!terms.length) return []

  const projectId = options.projectId || process.env.GITLAB_PROJECT_ID
  const maxFiles = Number(options.maxFiles || 8000)
  const maxMatches = Number(options.maxMatches || 20)
  const maxBytes = Number(options.maxBytes || 120_000)

  const { relPaths, fullPaths } = await getCachedTree(projectId)
  const out = []

  // Build prioritised scan order: path-matching files first
  const scanOrder = []
  const seen = new Set()
  for (let i = 0; i < relPaths.length; i++) {
    if (terms.some((t) => relPaths[i].toLowerCase().includes(t))) {
      scanOrder.push(i)
      seen.add(i)
    }
  }
  for (let i = 0; i < relPaths.length; i++) {
    if (!seen.has(i)) scanOrder.push(i)
  }

  let scannedFiles = 0
  const BATCH = LOCAL_REPO ? 40 : 10  // smaller batches for API to limit concurrent requests
  const scanLimit = LOCAL_REPO ? maxFiles : Math.min(maxFiles, 200) // cap API scans
  for (let b = 0; b < scanOrder.length && out.length < maxMatches; b += BATCH) {
    const batch = scanOrder.slice(b, b + BATCH)
    const results = await Promise.all(batch.map(async (idx) => {
      const rel = relPaths[idx]
      const ext = path.extname(rel).toLowerCase()
      if (!SEARCHABLE_EXTENSIONS.has(ext)) return null
      if (rel.includes("/dist/") || rel.includes("/build/") || rel.includes("/coverage/")) return null

      try {
        let content
        if (LOCAL_REPO && fullPaths) {
          const stat = await fs.stat(fullPaths[idx])
          if (stat.size > maxBytes) return null
          content = await fs.readFile(fullPaths[idx], "utf8")
        } else {
          content = await getFileContent(projectId, rel)
          if (content.length > maxBytes) return null
        }
        const lc = content.toLowerCase()
        if (!terms.some((t) => lc.includes(t))) return null

        const hits = []
        const lines = content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (terms.some((t) => lines[i].toLowerCase().includes(t))) {
            hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 220) })
          }
        }
        return hits
      } catch { return null }
    }))

    for (const r of results) {
      if (!r) { scannedFiles++; continue }
      scannedFiles++
      for (const hit of r) {
        if (out.length >= maxMatches) break
        out.push(hit)
      }
    }
    if (scannedFiles > scanLimit) break
  }

  return out
}

/**
 * Two-phase candidate search for bug-fixing:
 * Phase 1: Score every file by how many keywords appear in its PATH (instant, cached)
 * Phase 2: Read top path-matches and re-score by CONTENT keyword overlap
 * Returns top files sorted by total score, each with multiple code snippets.
 */
export async function findCandidateFiles(keywords, options = {}) {
  const projectId = options.projectId || process.env.GITLAB_PROJECT_ID
  const terms = [...new Set((keywords || []).map((k) => String(k || "").toLowerCase()).filter(Boolean))]
  if (!terms.length) return []

  const maxResults = Number(options.maxResults || 15)
  // For API mode, scan fewer files since each is an HTTP request
  const maxScan = LOCAL_REPO ? Number(options.maxScan || 500) : Math.min(Number(options.maxScan || 500), 60)
  const maxBytes = 200_000
  const snippetLines = Number(options.snippetLines || 3)

  const { relPaths, fullPaths } = await getCachedTree(projectId)

  // Phase 1: score files by path keyword overlap (no I/O)
  const scored = []
  for (let i = 0; i < relPaths.length; i++) {
    const lc = relPaths[i].toLowerCase()
    const ext = path.extname(relPaths[i]).toLowerCase()
    if (!SEARCHABLE_EXTENSIONS.has(ext)) continue
    if (lc.includes("/dist/") || lc.includes("/build/") || lc.includes("/coverage/")) continue

    const pathHits = terms.filter((t) => lc.includes(t)).length
    if (pathHits === 0) continue

    let bonus = 0
    if ([".tsx", ".jsx", ".vue"].includes(ext)) bonus += 3
    if (lc.includes("/test/") || lc.includes("/__tests__/") || /\.(test|spec)\./.test(lc)) bonus -= 6
    if (lc.includes("/types/") || lc.includes("/interfaces/") || lc.endsWith(".d.ts")) bonus -= 4
    if (lc.includes("/api/")) bonus -= 3
    scored.push({ idx: i, pathScore: pathHits * 5 + bonus })
  }

  scored.sort((a, b) => b.pathScore - a.pathScore)
  const toScan = scored.slice(0, maxScan)

  // Phase 2: read candidates and score by content keyword overlap
  const BATCH = LOCAL_REPO ? 50 : 10
  const results = []
  for (let b = 0; b < toScan.length; b += BATCH) {
    const slice = toScan.slice(b, b + BATCH)
    const batchResults = await Promise.all(slice.map(async ({ idx, pathScore }) => {
      try {
        let content
        if (LOCAL_REPO && fullPaths) {
          content = await fs.readFile(fullPaths[idx], "utf8")
        } else {
          content = await getFileContent(projectId, relPaths[idx])
        }
        if (content.length > maxBytes) return null
        const lc = content.toLowerCase()
        const contentHits = terms.filter((t) => lc.includes(t)).length
        if (contentHits === 0) return null

        const totalScore = pathScore + contentHits * 3

        // Collect top N lines with most keyword matches
        const lines = content.split(/\r?\n/)
        const lineScores = []
        for (let i = 0; i < Math.min(lines.length, 800); i++) {
          const ll = lines[i].toLowerCase()
          const lm = terms.filter((t) => ll.includes(t)).length
          if (lm > 0) lineScores.push({ line: i, score: lm, text: lines[i].trim().slice(0, 200) })
        }
        lineScores.sort((a, b) => b.score - a.score)
        const topSnippets = lineScores.slice(0, snippetLines).map((s) => s.text)

        return { path: relPaths[idx], score: totalScore, snippets: topSnippets }
      } catch { return null }
    }))
    for (const r of batchResults) {
      if (r) results.push(r)
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, maxResults)
}

/**
 * Find files in the repo whose name matches tokens extracted from a text.
 * For example, "same color as paid status in StatusCell" → finds files with "StatusCell" in the name.
 * Returns an array of relative paths.
 */
export async function findReferencedFiles(text, { exclude = [], limit = 4, projectId } = {}) {
  projectId = projectId || process.env.GITLAB_PROJECT_ID

  // Extract potential file/component names: PascalCase, camelCase, or kebab-case words ≥ 4 chars
  const tokens = new Set()
  // PascalCase / camelCase (e.g. StatusCell, paymentStatusCell)
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9]{3,})\b/g)) tokens.add(m[1].toLowerCase())
  // Also try joining adjacent lowercase words that look like a component name (e.g. "statuscell" → "statuscell")
  for (const m of text.matchAll(/\b([a-z][a-z0-9]{4,})\b/g)) {
    // Only keep if it looks like a compound word (contains a recognizable suffix)
    if (/cell|table|form|modal|dialog|list|card|view|page|button|input|panel|tab/i.test(m[1])) {
      tokens.add(m[1].toLowerCase())
    }
  }
  // kebab-case or snake_case tokens (e.g. status-cell, status_cell)
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*[-_][a-z0-9-_]{2,})\b/g)) tokens.add(m[1].toLowerCase())
  // Quoted file names (e.g. "StatusCell.tsx")
  for (const m of text.matchAll(/["'`]([A-Za-z0-9._/-]+\.[a-z]{2,4})["'`]/g)) {
    const name = m[1].split("/").pop().replace(/\.[^.]+$/, "")
    if (name.length >= 3) tokens.add(name.toLowerCase())
  }

  if (!tokens.size) return []

  // Directories to skip in results
  const JUNK_DIRS = /\/(\.jest-cache|node_modules|\.next|dist|build|coverage|\.turbo|__mocks__)\//

  const excludeSet = new Set(exclude.map((p) => p.toLowerCase()))
  const { relPaths } = await getCachedTree(projectId)
  const matches = []

  for (const rp of relPaths) {
    if (excludeSet.has(rp.toLowerCase())) continue
    if (JUNK_DIRS.test("/" + rp)) continue
    // Skip test files
    if (/\/__test__\/|\.test\.|\.spec\./i.test(rp)) continue
    // Must be a source file
    const ext = path.extname(rp).toLowerCase()
    if (!SEARCHABLE_EXTENSIONS.has(ext)) continue

    const fileName = rp.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase()
    for (const token of tokens) {
      if (fileName === token || fileName.includes(token)) {
        matches.push(rp)
        break
      }
    }
  }

  // Rank matches by proximity to excluded paths (the target file)
  // Files in the same or nearby directory score higher
  if (matches.length > 1 && exclude.length) {
    const targetDir = exclude[0].includes("/") ? exclude[0].slice(0, exclude[0].lastIndexOf("/")) : ""
    const targetParts = targetDir.toLowerCase().split("/")
    matches.sort((a, b) => {
      const aParts = a.toLowerCase().split("/")
      const bParts = b.toLowerCase().split("/")
      let aShared = 0, bShared = 0
      for (let i = 0; i < Math.min(aParts.length, targetParts.length); i++) {
        if (aParts[i] === targetParts[i]) aShared++; else break
      }
      for (let i = 0; i < Math.min(bParts.length, targetParts.length); i++) {
        if (bParts[i] === targetParts[i]) bShared++; else break
      }
      return bShared - aShared
    })
  }

  return matches.slice(0, limit)
}

/**
 * List files in the same directory as the given file path (siblings).
 * Reads up to limit files from the cached tree.
 */
export async function getSiblingFiles(filePath, limit = 6, projectId) {
  projectId = projectId || process.env.GITLAB_PROJECT_ID
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ""
  const prefix = dir ? dir + "/" : ""
  const { relPaths } = await getCachedTree(projectId)
  const siblings = []
  for (const p of relPaths) {
    if (p === filePath) continue
    if (!p.startsWith(prefix)) continue
    // Only same-level files (no deeper nesting)
    if (p.slice(prefix.length).includes("/")) continue
    const ext = path.extname(p).toLowerCase()
    if (!SEARCHABLE_EXTENSIONS.has(ext)) continue
    siblings.push(p)
    if (siblings.length >= limit) break
  }
  return siblings
}

/**
 * Create a branch, commit code, and open a Merge Request.
 */
export async function createMR({
  projectId,
  branchName,
  codePath,
  codeContent,
  commitMessage = "AI bug fix",
  mrTitle = "AI Bug Fix",
  onStatus = () => {},
}) {
  try {
    onStatus("Creating branch…")
    await api.Branches.create(projectId, branchName, "main")
  } catch (err) {
    // If branch already exists, continue; otherwise surface error
    if (!/already exists/i.test(String(err.message || ""))) {
      onStatus(`Failed creating branch: ${err.message || err}`)
      throw err
    }
  }

  try {
    onStatus("Committing AI fix…")
    await api.Commits.create(projectId, branchName, commitMessage, [
      { action: "update", file_path: codePath, content: codeContent },
    ])
  } catch (err) {
    onStatus(`Failed committing changes: ${err.message || err}`)
    throw err
  }

  try {
    onStatus("Opening Merge Request…")
    const mr = await api.MergeRequests.create(
      projectId,
      branchName,
      "main",
      mrTitle,
      { remove_source_branch: true }
    )
    return mr.web_url
  } catch (err) {
    onStatus(`Failed creating MR: ${err.message || err}`)
    throw err
  }
}
