import { callAI, formatCodeReply } from "../ai.js"
import { systemPrompt } from "../system-prompt.js"

export async function handleAI(message) {
  const userPrompt = message.content.replace("!ai", "").trim()

  if (!userPrompt) {
    message.reply("Please provide a prompt.")
    return
  }

  message.reply("Thinking… :smiley_cat: ")

  try {
    const prompt = `${systemPrompt}\n\nUser request:\n${userPrompt}`
    const aiRaw = await callAI(prompt)
    message.channel.send(formatCodeReply(aiRaw))
  } catch (err) {
    console.error(err)
    message.reply("Error contacting AI.")
  }
}
