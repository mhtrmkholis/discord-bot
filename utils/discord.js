const MAX_LENGTH = 1900

export function sanitize(text) {
  const clean = String(text ?? "").replace(/\u0000/g, "")
  return clean.length > MAX_LENGTH ? `${clean.slice(0, MAX_LENGTH)}…` : clean
}

export async function safeEdit(msg, text) {
  const content = sanitize(text)
  if (!content.trim()) return
  await msg.edit(content)
}
