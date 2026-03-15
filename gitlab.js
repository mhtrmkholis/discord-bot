import { Gitlab } from "@gitbeaker/node"

const api = new Gitlab({
  token: process.env.GITLAB_TOKEN
})

/**
 * Create a branch, commit AI-generated code, and open a Merge Request.
 * @param {object} opts
 * @param {number|string} opts.projectId
 * @param {string} opts.branchName
 * @param {string} opts.codePath    - file to update in the repo
 * @param {string} opts.codeContent - new file content
 * @param {string} [opts.commitMessage]
 * @param {string} [opts.mrTitle]
 * @param {(status:string)=>void} [opts.onStatus] - progress callback
 */
export async function getFileContent(projectId, filePath, ref = "main") {
  const file = await api.RepositoryFiles.show(projectId, filePath, ref)
  return Buffer.from(file.content, "base64").toString("utf-8")
}

export async function listFiles(projectId, path = "", ref = "main") {
  const tree = await api.Repositories.tree(projectId, { path, ref, recursive: true })
  return tree.filter((item) => item.type === "blob").map((item) => item.path)
}

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
