import { callAI, extractCode } from "../ai.js"
import { createMR, getFileContent, listFiles, findCandidateFiles, getSiblingFiles, findReferencedFiles } from "../gitlab.js"
import { systemPrompt, analysisPrompt } from "../system-prompt.js"
import { sanitize, safeEdit, pickKeywords, computeDiff, formatDiffPages } from "../utils/discord.js"
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js"

// ---- Pending fixes ----
const pendingFixes = new Map()
const PENDING_TTL = 5 * 60_000

export function hasActiveSession(channelId, userId) {
  const p = pendingFixes.get(channelId)
  return p && p.userId === userId
}

function resetTimer(channelId, msg) {
  const p = pendingFixes.get(channelId)
  if (!p) return
  clearTimeout(p.timer)
  p.timer = setTimeout(() => {
    pendingFixes.delete(channelId)
    msg?.edit({ content: "⏰ Session expired. Run `!fix` again.", components: [] }).catch(() => {})
  }, PENDING_TTL)
}

function buttons(hasMore) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("fix_create_mr").setLabel("✅ Create MR").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("fix_discard").setLabel("❌ Discard").setStyle(ButtonStyle.Secondary),
  )
  if (hasMore) row.addComponents(new ButtonBuilder().setCustomId("fix_show_more").setLabel("📄 More").setStyle(ButtonStyle.Primary))
  return row
}

function diffPreview(codePath, original, fixed) {
  const diff = computeDiff(original, fixed)
  const { pages, totalChanges } = formatDiffPages(diff, 1400)
  const hasMore = pages.length > 1
  const label = hasMore ? ` (1/${pages.length})` : ""
  const text = `📋 **Fix for** \`${codePath}\` — ${totalChanges} line${totalChanges === 1 ? "" : "s"} changed${label}\n\`\`\`diff\n${pages[0]}\n\`\`\``
  return { text, pages, totalChanges, hasMore }
}

// ---- Button handler ----

export async function handleFixInteraction(interaction) {
  try {
    const p = pendingFixes.get(interaction.channel.id)
    if (!p) return interaction.reply({ content: "No pending fix.", ephemeral: true })
    if (interaction.user.id !== p.userId) return interaction.reply({ content: "Not your session.", ephemeral: true })

    if (interaction.customId === "fix_show_more") {
      p.pageIdx++
      const hasMore = p.pageIdx < p.diffPages.length - 1
      return interaction.reply({
        content: `\`\`\`diff\n${p.diffPages[p.pageIdx]}\n\`\`\`\nPage ${p.pageIdx + 1}/${p.diffPages.length}`,
        components: hasMore ? [buttons(true)] : [],
      })
    }

    if (interaction.customId === "fix_discard") {
      clearTimeout(p.timer)
      pendingFixes.delete(interaction.channel.id)
      try { await interaction.message.edit({ components: [] }) } catch {}
      return interaction.reply("🗑️ Discarded.")
    }

    if (interaction.customId === "fix_create_mr") {
      clearTimeout(p.timer)
      pendingFixes.delete(interaction.channel.id)
      try { await interaction.message.edit({ components: [] }) } catch {}
      await interaction.deferReply()
      try {
        const url = await createMR({
          projectId: process.env.GITLAB_PROJECT_ID,
          branchName: `fix/${Date.now()}`,
          codePath: p.codePath,
          codeContent: p.code,
          commitMessage: `fix: ${p.bugDesc.slice(0, 72)}`,
          mrTitle: `AI Fix: ${p.bugDesc.slice(0, 100)}`,
        })
        return interaction.editReply(`✅ MR created: ${url}`)
      } catch (err) {
        console.error(err)
        return interaction.editReply("❌ MR creation failed.")
      }
    }

    await interaction.deferUpdate()
  } catch (err) {
    console.error("Button error:", err)
    try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "❌ Error.", ephemeral: true }) } catch {}
  }
}

// ---- !continue fallback ----

export function handleContinue(message) {
  const p = pendingFixes.get(message.channel.id)
  if (!p) return message.reply("No pending fix.")
  if (p.userId !== message.author.id) return message.reply("Not your session.")
  clearTimeout(p.timer)
  pendingFixes.delete(message.channel.id)
  commitFix(message, p)
}

async function commitFix(message, p) {
  const status = await message.reply("⏳ Creating MR…")
  try {
    const url = await createMR({
      projectId: process.env.GITLAB_PROJECT_ID,
      branchName: `fix/${Date.now()}`,
      codePath: p.codePath,
      codeContent: p.code,
      commitMessage: `fix: ${p.bugDesc.slice(0, 72)}`,
      mrTitle: `AI Fix: ${p.bugDesc.slice(0, 100)}`,
      onStatus: (s) => safeEdit(status, `⏳ ${s}`).catch(() => {}),
    })
    await safeEdit(status, `✅ MR created for \`${p.codePath}\`: ${url}`)
  } catch (err) {
    console.error(err)
    await safeEdit(status, "❌ MR creation failed.")
  }
}

// ---- Follow-up ----

export async function handleFollowUp(message) {
  const p = pendingFixes.get(message.channel.id)
  if (!p || p.userId !== message.author.id) return false

  const instruction = message.content.trim()
  if (!instruction) return false

  p.history.push(instruction)
  if (p.history.length > 7) p.history.splice(1, 1)

  const status = await message.reply("🤖 Refining…")

  try {
    // Load any newly referenced files
    const newRefs = await findReferencedFiles(instruction, { exclude: [p.codePath] })
    if (newRefs.length) {
      const loaded = (await Promise.all(
        newRefs.map((rp) => getFileContent(process.env.GITLAB_PROJECT_ID, rp).then((c) => ({ path: rp, content: c })).catch(() => null))
      )).filter(Boolean)
      if (loaded.length) p.referenceContext = (p.referenceContext || "") + loaded.map((s) => `\n--- ${s.path} ---\n${s.content.slice(0, 8000)}`).join("\n")
    }

    const history = p.history.map((h, i) => i === 0 ? `Original bug: ${h}` : `Follow-up ${i}: ${h}`).join("\n")
    const refs = p.referenceContext ? `\n\nReference files:\n${p.referenceContext}` : ""

    const prompt = `File: ${p.codePath}\nOriginal:\n\`\`\`\n${p.originalCode}\n\`\`\`\n\nCurrent proposed:\n\`\`\`\n${p.code}\n\`\`\`${refs}\n\nConversation:\n${history}\n\nApply the latest instruction. Change ONLY what was asked. Return the full corrected file.`
    const { code } = extractCode(await callAI(prompt, systemPrompt))

    if (!code) { await safeEdit(status, "❌ Empty AI response. Try rephrasing."); return true }

    p.code = code
    const { text, pages, hasMore } = diffPreview(p.codePath, p.originalCode, code)
    p.diffPages = pages; p.pageIdx = 0; p.statusMsg = status
    await status.edit({ content: sanitize(text), components: [buttons(hasMore)] })
    resetTimer(message.channel.id, status)
  } catch (err) {
    console.error(err)
    await safeEdit(status, "❌ Refinement failed.")
  }
  return true
}

// ---- !fix ----

export async function handleFix(message) {
  const bugDesc = message.content.replace("!fix", "").trim()
  if (!bugDesc) return message.reply("Usage: `!fix describe the bug here`")

  const projectId = process.env.GITLAB_PROJECT_ID
  if (!projectId) return message.reply("Missing `GITLAB_PROJECT_ID` in .env")

  // Cancel previous session
  const prev = pendingFixes.get(message.channel.id)
  if (prev) { clearTimeout(prev.timer); pendingFixes.delete(message.channel.id) }

  const status = await message.reply("🔍 Searching…")

  try {
    const keywords = pickKeywords(bugDesc)

    // Phase 1+2: find candidate files
    const candidates = await findCandidateFiles(keywords, { projectId, maxResults: 15, maxScan: 500, snippetLines: 4 })

    let codePath

    if (candidates.length) {
      const top = candidates[0], runner = candidates[1]
      const highConf = top.score >= 20 && (!runner || top.score >= runner.score * 1.8)

      if (highConf) {
        codePath = top.path
      } else {
        // Use LIGHT model for file identification — it's just picking a path
        const topN = candidates.slice(0, 8)
        const list = topN.map((c, i) => `${i + 1}. ${c.path} (${c.score})\n${c.snippets.map((s) => "   " + s).join("\n")}`).join("\n")
        const rest = candidates.slice(8).map((c) => c.path).join("\n")
        const prompt = `Bug: ${bugDesc}\n\nCandidates:\n${list}${rest ? "\n\nMore:\n" + rest : ""}`
        codePath = (await callAI(prompt, analysisPrompt, { light: true })).replaceAll(/[`"'\n]/g, "").trim()

        if (!codePath || !candidates.some((c) => c.path === codePath)) codePath = top.path
      }
    } else {
      // Fallback: path list from tree
      const files = await listFiles(projectId)
      const kw = keywords.map((k) => k.toLowerCase())
      const ranked = [...files].sort((a, b) => {
        const sa = kw.filter((k) => a.toLowerCase().includes(k)).length
        const sb = kw.filter((k) => b.toLowerCase().includes(k)).length
        return sb - sa
      }).slice(0, 120)

      const prompt = `Bug: ${bugDesc}\n\nFiles:\n${ranked.join("\n")}`
      codePath = (await callAI(prompt, analysisPrompt, { light: true })).replaceAll(/[`"'\n]/g, "").trim()

      if (!codePath || !new Set(files).has(codePath)) {
        codePath = ranked.find((p) => new Set(files).has(p))
        if (!codePath) { await safeEdit(status, "❌ Could not identify the file."); return }
      }
    }

    await safeEdit(status, `📄 Reading \`${codePath}\`…`)

    // Parallel: read target + find siblings + find referenced files
    const [currentCode, siblingPaths, referencedPaths] = await Promise.all([
      getFileContent(projectId, codePath),
      getSiblingFiles(codePath, 4),
      findReferencedFiles(bugDesc, { exclude: [codePath] }),
    ])

    // Read all context files in parallel
    const allCtx = [...new Set([...siblingPaths, ...referencedPaths])]
    const refSet = new Set(referencedPaths)
    const ctxContents = (await Promise.all(
      allCtx.map((p) => getFileContent(projectId, p).then((c) => ({ path: p, content: c })).catch(() => null))
    )).filter(Boolean)

    const referenceContext = ctxContents
      .map((s) => `\n--- ${s.path} ---\n${s.content.slice(0, refSet.has(s.path) ? 8000 : 1500)}`)
      .join("\n")

    await safeEdit(status, "🤖 Fixing…")
    const fixPrompt = `File: ${codePath}\nCode:\n\`\`\`\n${currentCode}\n\`\`\`\n\nBug: ${bugDesc}${referenceContext ? `\n\nReference files:\n${referenceContext}` : ""}\n\nReturn ONLY the full corrected file.`
    const { code } = extractCode(await callAI(fixPrompt, systemPrompt))

    if (!code) { await safeEdit(status, "❌ Empty AI response."); return }

    const { text, pages, hasMore } = diffPreview(codePath, currentCode, code)
    await status.edit({ content: sanitize(text), components: [buttons(hasMore)] })

    pendingFixes.set(message.channel.id, {
      userId: message.author.id, codePath, code, originalCode: currentCode,
      bugDesc, history: [bugDesc], referenceContext, diffPages: pages, pageIdx: 0, statusMsg: status, timer: null,
    })
    resetTimer(message.channel.id, status)
  } catch (err) {
    console.error(err)
    await safeEdit(status, "❌ Pipeline failed — check logs.")
  }
}
