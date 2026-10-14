#!/usr/bin/env node
// Show that every planted defect in the answer key bites on its branch.
//
//   node calibration/verify/verify.mjs <fixture-clone> [branch ...]
//
// For each branch (default: every branch in calibration/manifest.json), checks
// out the branch and its merge base with main into temporary worktrees outside
// the clone, runs the branch's check, and prints DEFECT or NO DEFECT per
// planted defect. Exits 1 if a planted defect does not show, or has no check.
// Clean branches have nothing to show and are listed as clean.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checks } from './checks.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [clone, ...only] = process.argv.slice(2)
if (!clone) {
  console.error('usage: verify.mjs <fixture-clone> [branch ...]')
  process.exit(2)
}
const git = (...args) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const manifest = JSON.parse(await readFile(path.join(here, '..', 'manifest.json'), 'utf8'))
const branches = only.length ? only : [...new Set([...manifest.defects.map((d) => d.branch), ...manifest.clean.map((c) => c.branch)])]

const refOf = (branch) => {
  for (const ref of [branch, `origin/${branch}`]) {
    try {
      git('rev-parse', '--verify', '-q', `${ref}^{commit}`)
      return ref
    } catch {}
  }
  throw new Error(`no branch ${branch} in ${clone}`)
}
const mainRef = refOf('main')

async function worktree(ref) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'advcal-wt-'))
  git('worktree', 'add', '--detach', '-q', dir, ref)
  return dir
}
async function drop(dir) {
  try {
    git('worktree', 'remove', '--force', dir)
  } catch {
    await rm(dir, { recursive: true, force: true })
  }
}

function contextFor(root, baseRoot) {
  const S = (p) => import(pathToFileURL(path.join(root, 'src', p)).href)
  const fresh = async () => {
    const { Store, now } = await S('store.js')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'advcal-'))
    const store = await Store.open(path.join(dir, 'l.json'))
    await store.migrate(path.join(root, 'src', 'migrations'))
    const admin = store.insert('users', { id: 'usr_a', name: 'A', token: 'ta', role: 'admin', createdAt: now() })
    const member = store.insert('users', { id: 'usr_m', name: 'M', token: 'tm', role: 'member', createdAt: now() })
    const other = store.insert('users', { id: 'usr_o', name: 'O', token: 'to', role: 'member', createdAt: now() })
    return { dir, store, admin, member, other }
  }
  const open = async (store, who, label) => (await S('accounts.js')).openAccount(store, { ownerId: who.id, label, actorId: who.id })
  const serve = async (store, options = {}) => {
    const { createServer } = await S('server.js')
    const server = createServer(store, { exportDir: path.join(os.tmpdir(), 'advcal-exports'), ...options })
    await new Promise((resolve) => server.listen(0, resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const call = async (method, route, { token, body, headers } = {}) => {
      const res = await fetch(base + route, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(headers ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      return { status: res.status, body: await res.json() }
    }
    return { call, server, close: () => new Promise((resolve) => server.close(resolve)) }
  }
  return { S, fresh, open, serve, root, baseRoot }
}
void http

let bad = 0
for (const branch of branches) {
  const planted = manifest.defects.filter((d) => d.branch === branch).map((d) => d.id)
  const check = checks[branch]
  if (!planted.length) {
    console.log(`clean      ${branch}`)
    continue
  }
  if (!check) {
    console.log(`NO CHECK   ${branch}: ${planted.join(', ')}`)
    bad++
    continue
  }
  const ref = refOf(branch)
  const root = await worktree(ref)
  const baseRoot = await worktree(git('merge-base', ref, mainRef))
  try {
    const results = await check(contextFor(root, baseRoot))
    for (const id of planted) {
      const r = results.find((x) => x.id === id)
      if (!r) {
        console.log(`NO CHECK   ${branch} ${id}`)
        bad++
        continue
      }
      console.log(`${r.defect ? 'DEFECT    ' : 'NO DEFECT '} ${id.padEnd(4)} ${branch}: ${r.name}\n                expected ${r.expect}\n                actual   ${r.actual}`)
      if (!r.defect) bad++
    }
  } catch (err) {
    console.log(`ERROR      ${branch}: ${err.stack ?? err}`)
    bad++
  } finally {
    await drop(root)
    await drop(baseRoot)
  }
}
try {
  git('worktree', 'prune')
} catch {}
console.log(bad ? `\n${bad} planted defect(s) did not show` : '\nevery planted defect shows')
process.exit(bad ? 1 : 0)
