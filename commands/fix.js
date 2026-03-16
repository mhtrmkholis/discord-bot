import { callAI, extractCode } from "../ai.js"
import { createMR, getFileContent, listFiles, findCandidateFiles, getSiblingFiles, findReferencedFiles } from "../gitlab.js"
import { systemPrompt, analysisPrompt } from "../system-prompt.js"
import { sanitize, safeEdit, pickKeywords, computeDiff, formatDiffPages } from "../utils/discord.js"
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js"

// ---- Pending fixes awaiting button click or follow-up ----
const pendingFixes = new Map()
// channelId → { userId, codePath, code, originalCode, bugDesc, history[], referenceContext, diffPages, pageIdx, timer }
const PENDING_TTL_MS = 5 * 60_000

/** Check if a channel has an active fix session for a given user */
export function hasActiveSession(channelId, userId) {
  const p = pendingFixes.get(channelId)
  return p && p.userId === userId
}

/** Reset the expiry timer for a pending fix */
function resetTimer(channelId, statusMsg) {
  const pending = pendingFixes.get(channelId)
  if (!pending) return
  clearTimeout(pending.timer)
  pending.timer = setTimeout(() => {
    pendingFixes.delete(channelId)
    if (statusMsg) statusMsg.edit({ content: `⏰ Fix session expired (5 min idle). Run \`!fix\` again.`, components: [] }).catch(() => {})
  }, PENDING_TTL_MS)
}

/** Build the action row buttons for a pending fix */
function buildButtons(hasMorePages) {
  const row = new ActionRowBuilder()
  row.addComponents(
    new ButtonBuilder()
      .setCustomId("fix_create_mr")
      .setLabel("✅ Create MR")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("fix_discard")
      .setLabel("❌ Discard")
      .setStyle(ButtonStyle.Secondary),
  )
  if (hasMorePages) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId("fix_show_more")
        .setLabel("📄 Show More")
        .setStyle(ButtonStyle.Primary),
    )
  }
  return row
}

/** Handle button interactions from the Discord client */
export async function handleFixInteraction(interaction) {
  try {
    const pending = pendingFixes.get(interaction.channel.id)
    if (!pending) {
      await interaction.reply({ content: "No pending fix. Run `!fix` first.", ephemeral: true })
      return
    }
    if (interaction.user.id !== pending.userId) {
      await interaction.reply({ content: "Only the person who ran `!fix` can use these buttons.", ephemeral: true })
      return
    }

    const id = interaction.customId

    if (id === "fix_show_more") {
      pending.pageIdx += 1
      const page = pending.diffPages[pending.pageIdx]
      const hasMore = pending.pageIdx < pending.diffPages.length - 1
      const pageLabel = `Page ${pending.pageIdx + 1}/${pending.diffPages.length}`
      await interaction.reply({
        content: `\`\`\`diff\n${page}\n\`\`\`\n${pageLabel}`,
        components: hasMore ? [buildButtons(true)] : [],
      })
      return
    }

    if (id === "fix_discard") {
      clearTimeout(pending.timer)
      pendingFixes.delete(interaction.channel.id)
      try { await interaction.message.edit({ components: [] }) } catch {}
      await interaction.reply("🗑️ Fix discarded.")
      return
    }

    if (id === "fix_create_mr") {
      clearTimeout(pending.timer)
      pendingFixes.delete(interaction.channel.id)
      try { await interaction.message.edit({ components: [] }) } catch {}
      await interaction.deferReply()
      try {
        const projectId = process.env.GITLAB_PROJECT_ID
        const branchName = `fix/${Date.now()}`
        const mrUrl = await createMR({
          projectId,
          branchName,
          codePath: pending.codePath,
          codeContent: pending.code,
          commitMessage: `fix: ${pending.bugDesc.slice(0, 72)}`,
          mrTitle: `AI Fix: ${pending.bugDesc.slice(0, 100)}`,
          onStatus: () => {},
        })
        await interaction.editReply(`✅ MR created for \`${pending.codePath}\`: ${mrUrl}`)
      } catch (err) {
        console.error(err)
        await interaction.editReply("❌ MR creation failed — check logs.")
      }
      return
    }

    // Unknown button — acknowledge to avoid "interaction failed"
    await interaction.deferUpdate()
  } catch (err) {
    console.error("handleFixInteraction error:", err)
    // Last resort: try to acknowledge so Discord doesn't show "interaction failed"
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Something went wrong.", ephemeral: true })
      }
    } catch {}
  }
}

// Keep text-based !continue as fallback
export function handleContinue(message) {
  const pending = pendingFixes.get(message.channel.id)
  if (!pending) {
    message.reply("No pending fix. Run `!fix` first.")
    return
  }
  if (pending.userId !== message.author.id) {
    message.reply("Only the person who ran `!fix` can continue.")
    return
  }
  clearTimeout(pending.timer)
  pendingFixes.delete(message.channel.id)
  commitPendingFix(message, pending)
}

async function commitPendingFix(message, pending) {
  const projectId = process.env.GITLAB_PROJECT_ID
  const status = await message.reply("⏳ Creating MR…")
  try {
    const branchName = `fix/${Date.now()}`
    const mrUrl = await createMR({
      projectId,
      branchName,
      codePath: pending.codePath,
      codeContent: pending.code,
      commitMessage: `fix: ${pending.bugDesc.slice(0, 72)}`,
      mrTitle: `AI Fix: ${pending.bugDesc.slice(0, 100)}`,
      onStatus: (s) => { safeEdit(status, `⏳ ${s}`).catch(() => {}) },
    })
    await safeEdit(status, `✅ MR created for \`${pending.codePath}\`: ${mrUrl}`)
  } catch (err) {
    console.error(err)
    await safeEdit(status, "❌ MR creation failed — check logs.")
  }
}

/** Handle follow-up messages during an active fix session */
export async function handleFollowUp(message) {
  const pending = pendingFixes.get(message.channel.id)
  if (!pending || pending.userId !== message.author.id) return false

  const instruction = message.content.trim()
  if (!instruction) return false

  // Track conversation history (keep last 6 to avoid prompt bloat)
  pending.history.push(instruction)
  if (pending.history.length > 7) pending.history.splice(1, 1)

  const status = await message.reply("🤖 Refining fix…")

  try {
    // Detect any new file references in the follow-up and load them
    const newRefs = await findReferencedFiles(instruction, { exclude: [pending.codePath] })
    if (newRefs.length) {
      const projectId = process.env.GITLAB_PROJECT_ID
      const newContents = await Promise.all(
        newRefs.map((rp) =>
          getFileContent(projectId, rp).then((c) => ({ path: rp, content: c })).catch(() => null)
        )
      )
      const newContext = newContents.filter(Boolean)
        .map((s) => `\n--- ${s.path} ---\n${s.content.slice(0, 8000)}`)
        .join("\n")
      if (newContext) {
        pending.referenceContext = (pending.referenceContext || "") + newContext
      }
    }

    const historyContext = pending.history
      .map((h, i) => i === 0 ? `Original bug: ${h}` : `Follow-up ${i}: ${h}`)
      .join("\n")

    const refSection = pending.referenceContext
      ? `\n\nReference files (find the EXACT values, colors, class names from these files and use them):\n${pending.referenceContext}`
      : ""

    const refinementPrompt = `${systemPrompt}\n\nFile: ${pending.codePath}\nOriginal code (before any changes):\n\`\`\`\n${pending.originalCode}\n\`\`\`\n\nCurrent proposed code:\n\`\`\`\n${pending.code}\n\`\`\`${refSection}\n\nConversation:\n${historyContext}\n\nApply the latest instruction. When the user says "same as" or "match" another file, find the EXACT values from the reference files above. Change ONLY what was asked — do not touch imports, do not reorganize code. Return ONLY the full corrected file.`
    const aiRaw = await callAI(refinementPrompt)
    const { code } = extractCode(aiRaw)

    if (!code) {
      await safeEdit(status, "❌ AI returned an empty response. Try rephrasing.")
      return true
    }

    // Update pending with new code, diff against original
    pending.code = code
    const diff = computeDiff(pending.originalCode, code)
    const { pages: diffPages, totalChanges } = formatDiffPages(diff, 1400)
    pending.diffPages = diffPages
    pending.pageIdx = 0

    const firstPage = diffPages[0]
    const hasMorePages = diffPages.length > 1
    const pageLabel = hasMorePages ? ` (page 1/${diffPages.length})` : ""

    const preview = `📋 **Updated fix for** \`${pending.codePath}\` — ${totalChanges} line${totalChanges === 1 ? "" : "s"} changed${pageLabel}\n\`\`\`diff\n${firstPage}\n\`\`\``
    const row = buildButtons(hasMorePages)
    await status.edit({ content: sanitize(preview), components: [row] })

    pending.statusMsg = status
    resetTimer(message.channel.id, status)
  } catch (err) {
    console.error(err)
    await safeEdit(status, "❌ Refinement failed — check logs.")
  }

  return true
}

function rankPaths(paths, keywords) {
  const kw = (keywords || []).map((k) => k.toLowerCase())
  return [...paths]
    .map((p) => {
      const lc = String(p).toLowerCase()
      let score = kw.filter((k) => lc.includes(k)).length * 2
      if ([".tsx", ".jsx", ".vue"].some((ext) => lc.endsWith(ext))) score += 2
      if (lc.includes("/test/") || lc.includes("/__tests__/") || lc.includes(".test.") || lc.includes(".spec.")) score -= 3
      if (lc.includes("/api/")) score -= 2
      return { path: p, score }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.path)
}

export async function handleFix(message) {
  const bugDesc = message.content.replace("!fix", "").trim()

  if (!bugDesc) {
    message.reply("Usage: `!fix describe the bug here`")
    return
  }

  const projectId = process.env.GITLAB_PROJECT_ID

  if (!projectId) {
    message.reply("Missing `GITLAB_PROJECT_ID` in .env")
    return
  }

  // Cancel any existing pending fix in this channel
  const prevPending = pendingFixes.get(message.channel.id)
  if (prevPending) {
    clearTimeout(prevPending.timer)
    pendingFixes.delete(message.channel.id)
  }

  const status = await message.reply("🔍 Analyzing bug…")

  try {
    const keywords = pickKeywords(bugDesc)

    // Two-phase candidate search: path → content scoring
    let candidates = []
    if (process.env.LOCAL_REPO_PATH) {
      candidates = await findCandidateFiles(keywords, { maxResults: 15, maxScan: 500, snippetLines: 4 })
    }

    let codePath

    if (candidates.length) {
      // High-confidence fast-path: skip AI identification when top candidate
      // clearly dominates (score >= 1.8× runner-up)
      const topScore = candidates[0].score
      const runnerUp = candidates.length > 1 ? candidates[1].score : 0
      const highConfidence = topScore >= 20 && (runnerUp === 0 || topScore >= runnerUp * 1.8)

      if (highConfidence) {
        codePath = candidates[0].path
        await safeEdit(status, `🎯 High-confidence match: \`${codePath}\` (score ${topScore} vs ${runnerUp})`)
      } else {
        // Build enriched prompt with file paths + multiple code snippets
        const topN = candidates.slice(0, 8)
        const snippetList = topN
          .map((c, i) => {
            const snips = c.snippets.map((s) => `   ${s}`).join("\n")
            return `${i + 1}. ${c.path} (score: ${c.score})\n${snips}`
          })
          .join("\n")
        const restPaths = candidates.slice(8).map((c) => c.path).join("\n")

        await safeEdit(status, "🔍 Identifying affected file…")
        const identifyPrompt = `${analysisPrompt}\n\nBug description: ${bugDesc}\n\nTop candidates (with code snippets):\n${snippetList}${restPaths ? "\n\nOther candidates:\n" + restPaths : ""}`
        codePath = (await callAI(identifyPrompt)).replaceAll(/[`"'\n]/g, "").trim()

        // Validate — must be one of the candidates
        const candidateSet = new Set(candidates.map((c) => c.path))
        if (!codePath || !candidateSet.has(codePath)) {
          codePath = candidates[0].path
          await safeEdit(status, `⚠️ AI returned unknown path, using top candidate: \`${codePath}\``)
        }
      }
    } else {
      // Fallback: no local repo — use file list from GitLab API
      const files = await listFiles(projectId)
      const fileSet = new Set(files)
      const ranked = rankPaths(files, keywords)
      const filesToSend = ranked.slice(0, 120)

      await safeEdit(status, "🔍 Identifying affected file…")
      const identifyPrompt = `${analysisPrompt}\n\nBug description: ${bugDesc}\n\nRepository files:\n${filesToSend.join("\n")}`
      codePath = (await callAI(identifyPrompt)).replaceAll(/[`"'\n]/g, "").trim()

      if (!codePath || !fileSet.has(codePath)) {
        const fallbackPath = filesToSend.find((p) => fileSet.has(p))
        if (!fallbackPath) {
          await safeEdit(status, `❌ Could not identify the file. AI suggested: \`${sanitize(codePath)}\``)
          return
        }
        codePath = fallbackPath
      }
    }

    // Read the target file + sibling files + referenced files for context (parallel)
    await safeEdit(status, `📄 Reading \`${codePath}\` + context files…`)
    const siblingPaths = await getSiblingFiles(codePath, 4)
    const referencedPaths = await findReferencedFiles(bugDesc, { exclude: [codePath, ...siblingPaths] })
    const allContextPaths = [...new Set([...siblingPaths, ...referencedPaths])]

    const [currentCode, ...contextContents] = await Promise.all([
      getFileContent(projectId, codePath),
      ...allContextPaths.map((sp) =>
        getFileContent(projectId, sp).then((c) => ({ path: sp, content: c })).catch(() => null)
      ),
    ])

    // Build reference context — referenced files get full content, siblings get truncated
    const refSet = new Set(referencedPaths)
    const referenceContext = contextContents.filter(Boolean)
      .map((s) => {
        const maxChars = refSet.has(s.path) ? 8000 : 1500
        return `\n--- ${s.path} ---\n${s.content.slice(0, maxChars)}`
      })
      .join("\n")

    await safeEdit(status, "🤖 Generating fix…")
    const fixPrompt = `${systemPrompt}\n\nFile to fix: ${codePath}\nCurrent code:\n\`\`\`\n${currentCode}\n\`\`\`\n\nBug description: ${bugDesc}${referenceContext ? `\n\nReference files (use these to find the EXACT values, colors, class names, patterns to copy — but do NOT change imports or structure of the target file):\n${referenceContext}` : ""}\n\nIMPORTANT: When the bug says "same as" or "match", find the EXACT values from the reference files and use them. Your output must be the EXACT same file with ONLY the bug-related lines changed. Do not touch imports, do not reorganize, do not rename.\nReturn ONLY the full corrected file for ${codePath}.`
    const aiRaw = await callAI(fixPrompt)
    const { code } = extractCode(aiRaw)

    if (!code) {
      await safeEdit(status, "❌ AI returned an empty response.")
      return
    }

    // Show before/after diff with buttons
    const diff = computeDiff(currentCode, code)
    const { pages: diffPages, totalChanges } = formatDiffPages(diff, 1400)
    const firstPage = diffPages[0]
    const hasMorePages = diffPages.length > 1
    const pageLabel = hasMorePages ? ` (page 1/${diffPages.length})` : ""

    const preview = `📋 **Proposed fix for** \`${codePath}\` — ${totalChanges} line${totalChanges === 1 ? "" : "s"} changed${pageLabel}\n\`\`\`diff\n${firstPage}\n\`\`\``
    const row = buildButtons(hasMorePages)
    await status.edit({ content: sanitize(preview), components: [row] })

    pendingFixes.set(message.channel.id, {
      userId: message.author.id,
      codePath,
      code,
      originalCode: currentCode,
      bugDesc,
      history: [bugDesc],
      referenceContext,
      diffPages,
      pageIdx: 0,
      statusMsg: status,
      timer: null,
    })
    resetTimer(message.channel.id, status)
  } catch (err) {
    console.error(err)
    await safeEdit(status, "❌ Pipeline failed — check logs for details.")
  }
}
