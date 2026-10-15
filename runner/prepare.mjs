// What the Claude Code session does before launching the workflow, as code:
// resolve the pull request or branch, fetch its head, write the diff outside
// the repository, read the project's configuration, and build the workflow's
// arguments. SKILL.md §2 describes the same steps in prose; this is the
// reference.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defaultExec } from './worktree.mjs'

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const INTENT_MAX = 1000

/** The author's words, verbatim and bounded; the runner has no model to summarise with. */
export const intentFrom = (text) => {
  const t = flat(text)
  if (!t) return null
  return `verbatim excerpt, not a summary: ${t.length > INTENT_MAX ? `${t.slice(0, INTENT_MAX)}…` : t}`
}

const gitIn = (exec, repo) => (...args) => exec('git', ['-C', repo, ...args])
const ghIn = (exec, repo) => (...args) => exec('gh', args, { cwd: repo })

/** The repository's default branch as a local ref, or the first of the usual names that exists. */
export async function defaultBase(repo, exec = defaultExec) {
  const git = gitIn(exec, repo)
  try {
    const ref = (await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim()
    if (ref) return ref
  } catch {}
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await git('rev-parse', '--verify', '-q', `${ref}^{commit}`)
      return ref
    } catch {}
  }
  throw new Error('no base branch found: pass --base')
}

/** The project's `.claude/adv-review.json`: `{ project, agents, model }`; absent is fine, malformed is not. */
export async function readProjectConfig(repo) {
  const file = path.join(repo, '.claude', 'adv-review.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { project: null, agents: null, model: null }
  }
  let config
  try {
    config = JSON.parse(text)
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file} must hold an object`)
  const { agents = null, model = null, ...project } = config
  return { project, agents, model }
}

/** One or more pull requests (several = a stack, the last on top). */
export async function preparePr({ repo, prs, stackedOn = null, tmp, exec = defaultExec }) {
  const git = gitIn(exec, repo)
  const gh = ghIn(exec, repo)
  await mkdir(path.join(tmp, 'diffs'), { recursive: true })
  const views = []
  const diffs = []
  for (const n of prs) {
    const view = JSON.parse(await gh('pr', 'view', String(n), '--json', 'number,title,body,headRefOid,headRefName,baseRefName'))
    try {
      await git('fetch', '-q', 'origin', `pull/${n}/head`)
    } catch {}
    await git('cat-file', '-e', `${view.headRefOid}^{commit}`)
    const file = path.join(tmp, 'diffs', `pr-${n}.diff`)
    await writeFile(file, await gh('pr', 'diff', String(n)))
    views.push(view)
    diffs.push(file)
  }
  const tip = views[views.length - 1]
  return {
    target: { prs: prs.map(Number) },
    headSha: tip.headRefOid,
    diffs,
    title: views.map((v) => v.title).join(' + '),
    intent: intentFrom(views.map((v) => v.body).filter(Boolean).join('\n')),
    stackedOn,
    views,
  }
}

/** A branch against its base, with no pull request. */
export async function prepareBranch({ repo, branch, base, tmp, exec = defaultExec }) {
  const git = gitIn(exec, repo)
  const name = branch || (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim()
  if (!name || name === 'HEAD') throw new Error('not on a branch: pass --branch <name>')
  const headSha = (await git('rev-parse', `${name}^{commit}`)).trim()
  const baseRef = base || (await defaultBase(repo, exec))
  const mergeBase = (await git('merge-base', baseRef, headSha)).trim()
  if (mergeBase === headSha) throw new Error(`${name} has nothing beyond ${baseRef}: nothing to review`)
  await mkdir(path.join(tmp, 'diffs'), { recursive: true })
  const file = path.join(tmp, 'diffs', `branch-${name.replace(/\//g, '-')}.diff`)
  await writeFile(file, await git('diff', mergeBase, headSha))
  const log = (await git('log', '--format=%s%n%b', `${mergeBase}..${headSha}`)).trim()
  const count = Number((await git('rev-list', '--count', `${mergeBase}..${headSha}`)).trim())
  const subject = log.split('\n')[0] ?? ''
  let dirty = false
  try {
    dirty = (await git('status', '--porcelain')).trim().length > 0
  } catch {}
  return {
    target: { branch: name, base: baseRef },
    headSha,
    diffs: [file],
    title: count === 1 && subject ? subject : name,
    intent: intentFrom(log),
    dirty,
    commits: count,
  }
}

/** The workflow's `args`, from what was prepared, the command line and the project config. */
export function buildArgs(prepared, cli, config = {}) {
  const args = {
    ...prepared.target,
    diffs: prepared.diffs,
    headSha: prepared.headSha,
    title: prepared.title,
  }
  if (prepared.intent) args.intent = prepared.intent
  if (prepared.stackedOn) args.stackedOn = prepared.stackedOn
  if (config.project && Object.keys(config.project).length) args.project = config.project
  const agents = cli.agents ?? config.agents
  if (agents !== null && agents !== undefined) args.agents = agents
  // The config's `model` names a Claude model; `--model` applies to whichever CLI runs.
  const model = cli.model ?? (cli.agent === 'claude' ? config.model : null)
  if (model) args.model = model
  if (cli.run === false) args.run = false
  return args
}
