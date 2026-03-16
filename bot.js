import "dotenv/config"
import { Client, GatewayIntentBits } from "discord.js"
import { handleFix, handleContinue, handleFixInteraction, handleFollowUp, hasActiveSession } from "./commands/fix.js"
import { handleMR } from "./commands/mr.js"
import { handleAI } from "./commands/ai.js"

const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const ALLOWED_DISCORD_CHANNEL = process.env.ALLOWED_DISCORD_CHANNEL

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN. Add it to .env or export it in your shell.")
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.once("clientReady", () => {
  console.log("Bot is online 🚀")
})

client.on("messageCreate", async (message) => {
  if (message.author.bot) return
  if (message.channel.id !== ALLOWED_DISCORD_CHANNEL) return

  if (message.content.startsWith("!fix")) return handleFix(message)
  if (message.content.startsWith("!continue")) return handleContinue(message)
  if (message.content.startsWith("!mr"))  return handleMR(message)
  if (message.content.startsWith("!ai"))  return handleAI(message)

  // Non-command message: check if user has an active fix session
  if (hasActiveSession(message.channel.id, message.author.id)) {
    return handleFollowUp(message)
  }
})

// Handle button clicks (Create MR, Discard, Show More)
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return
  if (interaction.channel.id !== ALLOWED_DISCORD_CHANNEL) return
  if (interaction.customId.startsWith("fix_")) return handleFixInteraction(interaction)
})

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Discord login failed:", err.message)
  process.exit(1)
})