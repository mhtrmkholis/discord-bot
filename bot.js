import "dotenv/config"
import { Client, GatewayIntentBits } from "discord.js"
import { handleFix, handleContinue, handleFixInteraction, handleFollowUp, hasActiveSession } from "./commands/fix.js"
import { handleMR } from "./commands/mr.js"
import { handleAI } from "./commands/ai.js"
import { handleConfig } from "./commands/config.js"
import { warmCache } from "./gitlab.js"

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

const CHANNEL = process.env.ALLOWED_DISCORD_CHANNEL

client.once("clientReady", () => {
  console.log("Bot is online 🚀")
  if (process.env.GITLAB_PROJECT_ID) warmCache(process.env.GITLAB_PROJECT_ID)
})

client.on("messageCreate", async (message) => {
  if (message.author.bot || message.channel.id !== CHANNEL) return

  const text = message.content
  if (text.startsWith("!fix"))      return handleFix(message)
  if (text.startsWith("!continue")) return handleContinue(message)
  if (text.startsWith("!mr"))       return handleMR(message)
  if (text.startsWith("!ai"))       return handleAI(message)
  if (text.startsWith("!config"))   return handleConfig(message)

  if (hasActiveSession(message.channel.id, message.author.id)) return handleFollowUp(message)
})

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() || interaction.channel.id !== CHANNEL) return
  if (interaction.customId.startsWith("fix_")) return handleFixInteraction(interaction)
})

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("Login failed:", err.message)
  process.exit(1)
})
