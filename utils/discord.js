import { structuredPatch } from "diff"

const MAX_LENGTH = 1900

export function sanitize(text) {
  const clean = String(text ?? "").replaceAll("\0", "")
  return clean.length > MAX_LENGTH ? `${clean.slice(0, MAX_LENGTH)}…` : clean
}

export async function safeEdit(msg, text) {
  const content = sanitize(text)
  if (!content.trim()) return
  try {
    await msg.edit(content)
  } catch (err) {
    console.warn("safeEdit failed:", err?.message ?? err)
  }
}

/**
 * Compute a proper unified diff between two strings using LCS algorithm.
 * Returns { hunks, totalChanges } where hunks come from structuredPatch
 * and totalChanges counts actual added/removed lines (moves are ignored).
 */
export function computeDiff(oldText, newText) {
  const patch = structuredPatch("file", "file",
    String(oldText), String(newText), "", "", { context: 2 })
  let totalChanges = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line[0] === "+" || line[0] === "-") totalChanges++
    }
  }
  return { hunks: patch.hunks, totalChanges }
}

/**
 * Format hunks into paginated Discord-friendly diff strings.
 * Returns { pages: string[], totalChanges: number }.
 * Each page fits within maxLen characters to stay under Discord limits.
 */
export function formatDiffPages({ hunks, totalChanges }, maxLen = 1400) {
  if (!hunks.length) return { pages: ["(no changes detected)"], totalChanges: 0 }

  const pages = []
  let current = ""

  for (const hunk of hunks) {
    let block = `@@ line ${hunk.oldStart} → ${hunk.newStart} @@\n`
    for (const line of hunk.lines) {
      block += line + "\n"
    }

    if (current.length + block.length > maxLen) {
      if (current) pages.push(current.trimEnd())
      current = block
    } else {
      current += (current ? "\n" : "") + block
    }
  }
  if (current) pages.push(current.trimEnd())

  return { pages, totalChanges }
}

const STOP_WORDS = new Set([
  "that", "when", "this", "with", "from", "have", "same", "also", "does",
  "been", "into", "more", "than", "very", "just", "only", "they", "them",
  "then", "each", "make", "like", "will", "would", "could", "some", "here",
  "other", "about", "what", "which", "their", "there", "where", "were",
  "should", "showing", "being", "between", "before", "after", "while",
  "please", "need", "want", "using", "still", "every",
])

export function pickKeywords(input) {
  return [...new Set(
    String(input)
      .toLowerCase()
      .replaceAll(/[^a-z0-9_\-\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  )].slice(0, 12)
}
