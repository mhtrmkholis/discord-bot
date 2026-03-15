import { Gitlab } from "@gitbeaker/node"

const GITLAB_HOST = process.env.GITLAB_HOST || "https://gitlab.com"

const api = new Gitlab({
  host: GITLAB_HOST,
  token: process.env.GITLAB_TOKEN,
})

export async function getFileContent(projectId, filePath, ref = "main") {
  const file = await api.RepositoryFiles.show(projectId, filePath, ref)
  return Buffer.from(file.content, "base64").toString("utf-8")
}

export async function listFiles(projectId, path = "", ref = "main") {
  const tree = await api.Repositories.tree(projectId, { path, ref, recursive: true })
  return tree.filter((item) => item.type === "blob").map((item) => item.path)
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
  onStatus("Creating branch…")
  await api.Branches.create(projectId, branchName, "main")

  onStatus("Committing AI fix…")
  await api.Commits.create(projectId, branchName, commitMessage, [
    { action: "update", file_path: codePath, content: codeContent },
  ])

  onStatus("Opening Merge Request…")
  const mr = await api.MergeRequests.create(
    projectId,
    branchName,
    "main",
    mrTitle,
    { remove_source_branch: true }
  )

  return mr.web_url
}
