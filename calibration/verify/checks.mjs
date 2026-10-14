// One check per planted branch: it runs the branch's own code and shows the
// planted defect biting. Each result names the manifest defect it shows.
//
// A check gets `ctx`:
//   S(path)      import a module from the branch's src/
//   fresh()      a migrated store from the branch, with users admin 'ta', member 'tm', other 'to'
//   open(...)    openAccount with the original signature
//   serve(...)   the branch's server on a free port: { call, close, server }
//   root         the branch's worktree; baseRoot the worktree of its merge base with main
import { execFile } from 'node:child_process'
import { mkdtemp, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const capture = () => {
  const sent = []
  return {
    sent,
    webhook: {
      url: 'https://ops.example/hook',
      secret: 'k',
      delays: [],
      log: { warn: () => {} },
      send: async (url, init) => {
        sent.push({ url, event: JSON.parse(init.body).event, data: JSON.parse(init.body).data })
        return { ok: true }
      },
    },
  }
}

export const checks = {
  // ------------------------------------------------------------------ v1
  'feat/page-transfers': async ({ S, fresh, open }) => {
    const { deposit, transfer, transfersFor } = await S('transfers.js')
    const { store, admin, member } = await fresh()
    const a = await open(store, member, 'A')
    const b = await open(store, member, 'B')
    deposit(store, admin, { accountId: a.id, amountCents: 100 })
    const ids = []
    for (let i = 0; i < 21; i++) {
      const t = transfer(store, member, { fromId: a.id, toId: b.id, amountCents: 1 })
      t.createdAt = `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`
      ids.push(t.id)
    }
    const p1 = transfersFor(store, a.id, { page: 1 })
    const p2 = transfersFor(store, a.id, { page: 2 })
    const seen = new Set([...p1.items, ...p2.items].map((t) => t.id))
    const missing = ids.filter((id) => !seen.has(id))
    return [{ id: 'D1', name: 'each page drops its last item', expect: 'page 1 holds 20; pages 1 and 2 hold all 21', actual: `page 1 holds ${p1.items.length}; ${missing.length} on no page; total says ${p1.total}`, defect: p1.items.length === 19 && missing.length === 1 }]
  },
  'feat/memo-control-chars': async ({ S, fresh, open }) => {
    const { deposit, transfer } = await S('transfers.js')
    const { store, admin, member } = await fresh()
    const a = await open(store, member, 'A')
    const b = await open(store, member, 'B')
    deposit(store, admin, { accountId: a.id, amountCents: 100 })
    let out
    try {
      out = { threw: false, memo: transfer(store, member, { fromId: a.id, toId: b.id, amountCents: 1, memo: 'rent\u0000 due' }).memo }
    } catch (err) {
      out = { threw: true, message: err.message }
    }
    return [{ id: 'D2', name: 'a control character is stripped, not refused', expect: 'a 400 refusal', actual: out.threw ? `refused: ${out.message}` : `accepted, memo stored as ${JSON.stringify(out.memo)}`, defect: !out.threw && out.memo === 'rent due' }]
  },
  'refactor/open-account-actor': async ({ root }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'advcal-'))
    let out
    try {
      out = { code: 0, text: (await run('node', [path.join(root, 'scripts', 'seed.mjs')], { env: { ...process.env, LEDGER_FILE: path.join(dir, 'l.json') } })).stdout }
    } catch (err) {
      out = { code: err.code, text: err.stderr }
    }
    const line = out.text.split('\n').find((l) => /Error/.test(l)) ?? out.text.trim().split('\n')[0]
    return [{ id: 'D3', name: 'the seed script calls the old signature', expect: 'the seed exits 0', actual: `exit ${out.code}: ${line}`, defect: out.code !== 0 && /TypeError/.test(out.text) }]
  },
  'feat/overdraft': async ({ S, fresh, open }) => {
    const { setOverdraft } = await S('accounts.js')
    const { transfer } = await S('transfers.js')
    const { store, admin, member } = await fresh()
    const a = await open(store, member, 'A')
    const b = await open(store, member, 'B')
    setOverdraft(store, admin, { accountId: a.id, overdraftCents: 500 })
    const stored = store.get('accounts', a.id).overdraftCents
    let moved
    try {
      transfer(store, member, { fromId: a.id, toId: b.id, amountCents: 300 })
      moved = 'moved'
    } catch (err) {
      moved = err.message
    }
    return [{ id: 'D4', name: 'overdraftCents is dropped by the store', expect: 'stored 500; a 300 transfer from an empty account is covered', actual: `stored ${stored}; transfer: ${moved}`, defect: stored === undefined && moved === 'insufficient funds' }]
  },
  'feat/accountant-role': async ({ S, fresh, open }) => {
    const { closeAccount, getOwnAccount } = await S('accounts.js')
    const { exportTransfers } = await S('export.js')
    const { Store } = await S('store.js')
    const { store, member, dir } = await fresh()
    void Store
    const eve = store.insert('users', { id: 'usr_e', name: 'E', token: 'te', role: 'accountant', createdAt: 'now' })
    const a = await open(store, member, 'A')
    let closed
    try {
      closed = Boolean(closeAccount(store, eve, a.id).closedAt)
    } catch (err) {
      closed = err.message
    }
    const b = await open(store, member, 'B')
    let exported
    try {
      exported = (await exportTransfers(store, getOwnAccount(store, eve, b.id), path.join(dir, 'exports'))).file
    } catch (err) {
      exported = err.message
    }
    return [{ id: 'D5', name: "an accountant closes and exports a member's account", expect: 'both refused', actual: `close: ${closed === true ? 'closed it' : closed}; export: ${String(exported).endsWith('.csv') ? 'wrote the file' : exported}`, defect: closed === true && String(exported).endsWith('.csv') }]
  },
  'feat/transfer-on-behalf': async ({ S, fresh, open }) => {
    const { actingFor } = await S('auth.js')
    const { entriesFor } = await S('audit.js')
    const { deposit, transfer } = await S('transfers.js')
    const { store, admin, member } = await fresh()
    const a = await open(store, member, 'A')
    const b = await open(store, member, 'B')
    deposit(store, admin, { accountId: a.id, amountCents: 100 })
    const row = transfer(store, actingFor(store, admin, member.id), { fromId: a.id, toId: b.id, amountCents: 40 })
    const audit = entriesFor(store, row.id).map((e) => e.actorId)
    return [{ id: 'D6', name: "an administrator's transfer is recorded as the member's", expect: `actor ${admin.id}`, actual: `actorId ${row.actorId}; audit ${audit.join(',')}`, defect: row.actorId === member.id && audit.every((x) => x === member.id) }]
  },
  'feat/named-exports': async ({ S, fresh, open }) => {
    const { exportTransfers } = await S('export.js')
    const { requireUser } = await S('auth.js')
    const { store, member, dir } = await fresh()
    const a = await open(store, member, 'A')
    const exports = path.join(dir, 'exports')
    const { file } = await exportTransfers(store, a, exports, '../escaped')
    const outside = !path.resolve(file).startsWith(path.resolve(exports) + path.sep) && (await stat(file)).isFile()
    const warned = []
    const realWarn = console.warn
    console.warn = (...args) => warned.push(args.join(' '))
    try {
      await requireUser(async () => 'ran')({ req: { method: 'GET', url: '/accounts', headers: { authorization: 'Bearer SECRET-TOKEN-XYZ' } }, store })
    } catch {}
    console.warn = realWarn
    return [
      { id: 'D7', name: 'an export name escapes the export directory', expect: 'a file under exports/', actual: `wrote ${file}`, defect: outside },
      { id: 'D8', name: 'a bearer token is written to the log', expect: 'no token in the log', actual: warned.join(' | ') || '(nothing logged)', defect: warned.some((w) => w.includes('SECRET-TOKEN-XYZ')) },
    ]
  },
  'feat/withdrawals-summary': async ({ S, fresh, open }) => {
    const { deposit, summary, withdraw } = await S('transfers.js')
    const { store, admin, member } = await fresh()
    const a = await open(store, member, 'A')
    deposit(store, admin, { accountId: a.id, amountCents: 100 })
    withdraw(store, admin, { accountId: a.id, amountCents: 40 })
    const total = summary(store).AUD
    const balance = store.get('accounts', a.id).balanceCents
    return [{ id: 'D9', name: 'the summary ignores withdrawals', expect: 'summary AUD 60, as the balance', actual: `summary AUD ${total}; balance ${balance}`, defect: total === 100 && balance === 60 }]
  },
  'refactor/account-name': async ({ root, baseRoot }) => {
    const { Store } = await import(pathToFileURL(path.join(root, 'src', 'store.js')).href)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'advcal-'))
    const store = await Store.open(path.join(dir, 'l.json'))
    store.data.accounts.push({ id: 'acc_x', ownerId: 'u', label: 'Old', currency: 'AUD', balanceCents: 0, createdAt: 'a', updatedAt: 'a' })
    store.data.version = 2
    await store.migrate(path.join(root, 'src', 'migrations'))
    const acc = store.get('accounts', 'acc_x')
    const previous = await import(pathToFileURL(path.join(baseRoot, 'src', 'store.js')).href)
    const kept = Object.keys(previous.pick('accounts', acc)).filter((k) => ['label', 'name'].includes(k))
    return [{ id: 'D10', name: 'the rename removes the old key in the same migration', expect: 'label kept until no running copy reads it', actual: `after migration: label ${'label' in acc ? 'kept' : 'gone'}, name ${JSON.stringify(acc.name)}; the previous release's store keeps ${JSON.stringify(kept)}`, defect: !('label' in acc) && acc.name === 'Old' && kept.length === 0 }]
  },

  // ------------------------------------------------------------------ v2
  'feat/fraud-screening': async ({ S, fresh, open }) => {
    const { deposit, transfer } = await S('transfers.js')
    const { store, admin, member } = await fresh()
    const a = await open(store, member, 'A')
    const b = await open(store, member, 'B')
    deposit(store, admin, { accountId: a.id, amountCents: 150_000 })
    const screen = () => new Promise((resolve) => setTimeout(() => resolve({ allow: true }), 5))
    const both = await Promise.allSettled([1, 2].map(() => transfer(store, member, { fromId: a.id, toId: b.id, amountCents: 100_000 }, { screen })))
    const ok = both.filter((r) => r.status === 'fulfilled').length
    const from = store.get('accounts', a.id).balanceCents
    const to = store.get('accounts', b.id).balanceCents
    const recorded = store.all('transfers').reduce((sum, t) => sum + t.amountCents, 0)
    return [{ id: 'D11', name: 'two concurrent screened transfers both pass the funds check', expect: 'one moves, the other is refused for insufficient funds', actual: `${ok} succeeded; from ${from}, to ${to}; transfers on record ${recorded}`, defect: ok === 2 && recorded !== to }]
  },
  'feat/cache-account-list': async ({ fresh, serve }) => {
    const { store } = await fresh()
    const { call, close } = await serve(store)
    try {
      const a = await call('POST', '/accounts', { token: 'tm', body: { label: 'A' } })
      const before = (await call('GET', '/accounts', { token: 'tm' })).body.total
      await call('POST', '/accounts', { token: 'tm', body: { label: 'B' } })
      const after = (await call('GET', '/accounts', { token: 'tm' })).body.total
      await call('POST', `/accounts/${a.body.id}/close`, { token: 'tm' })
      const listed = (await call('GET', '/accounts', { token: 'tm' })).body.items.find((x) => x.id === a.body.id)
      return [{ id: 'D12', name: 'opening and closing do not clear the cached list', expect: 'the list shows the new account and the closed one as closed', actual: `total ${before} then ${after} after opening a second; closed account listed as closed: ${listed?.closed}`, defect: after === before && listed?.closed === false }]
    } finally {
      await close()
    }
  },
  'feat/interest-timer': async ({ root }) => {
    // Sydney, early morning: the local day is a day ahead of the UTC day.
    const script = `
      const { Store, newId } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'store.js')).href)})
      const { accrueInterest } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'interest.js')).href)})
      const store = new Store('/dev/null')
      store.save = async () => {}
      await store.migrate(${JSON.stringify(path.join(root, 'src', 'migrations'))})
      store.insert('accounts', { id: 'acc_s', ownerId: 'u', label: 'S', currency: 'AUD', balanceCents: 100000, interestRateBps: 500, closedAt: null, createdAt: 'a', updatedAt: 'a' })
      const clock = () => new Date('2026-03-01T20:00:00.000Z')
      const runs = [accrueInterest(store, { clock }), accrueInterest(store, { clock }), accrueInterest(store, { clock })]
      console.log(JSON.stringify({ runs, balance: store.get('accounts', 'acc_s').balanceCents }))`
    const { stdout } = await run('node', ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'Australia/Sydney' } })
    const { runs, balance } = JSON.parse(stdout)
    const credited = runs.filter((r) => r.accounts === 1).length
    return [{ id: 'D13', name: 'the once-a-day check compares a local day with a UTC day', expect: 'three runs in one Sydney morning credit once', actual: `credited ${credited} times; balance ${balance}`, defect: credited === 3 }]
  },
  'feat/idempotency-keys': async ({ fresh, serve }) => {
    const { store } = await fresh()
    const { call, close } = await serve(store)
    try {
      const a = await call('POST', '/accounts', { token: 'tm', body: { label: 'A' } })
      const b = await call('POST', '/accounts', { token: 'tm', body: { label: 'B' } })
      const c = await call('POST', '/accounts', { token: 'to', body: { label: 'C' } })
      const d = await call('POST', '/accounts', { token: 'to', body: { label: 'D' } })
      await call('POST', '/deposits', { token: 'ta', body: { accountId: a.body.id, amountCents: 1_000 } })
      await call('POST', '/deposits', { token: 'ta', body: { accountId: c.body.id, amountCents: 1_000 } })
      await call('POST', '/transfers', { token: 'tm', body: { fromId: a.body.id, toId: b.body.id, amountCents: 250, memo: 'private' }, headers: { 'idempotency-key': 'order-1' } })
      const theirs = await call('POST', '/transfers', { token: 'to', body: { fromId: c.body.id, toId: d.body.id, amountCents: 10 }, headers: { 'idempotency-key': 'order-1' } })
      const cBalance = (await call('GET', `/accounts/${c.body.id}`, { token: 'to' })).body.balanceCents
      return [{ id: 'D14', name: "one user's idempotency key returns another user's transfer", expect: "the second user's own transfer", actual: `second user got fromId ${theirs.body.fromId === a.body.id ? "of the first user's account" : theirs.body.fromId}, memo ${JSON.stringify(theirs.body.memo)}; their balance ${cBalance}`, defect: theirs.body.fromId === a.body.id && cBalance === 1_000 }]
    } finally {
      await close()
    }
  },
  'feat/account-webhooks': async ({ fresh, serve }) => {
    const { store } = await fresh()
    const { sent, webhook } = capture()
    const { call, close, server } = await serve(store, { webhook })
    try {
      const a = await call('POST', '/accounts', { token: 'tm', body: { label: 'A' } })
      const set = await call('POST', `/accounts/${a.body.id}/webhook`, { token: 'tm', body: { url: 'http://169.254.169.254/latest/meta-data/' } })
      await call('POST', '/deposits', { token: 'ta', body: { accountId: a.body.id, amountCents: 100 } })
      await server.notifier.idle()
      const internal = sent.filter((s) => s.url.startsWith('http://169.254.169.254'))
      return [{ id: 'D15', name: 'the server requests a URL a member supplied', expect: 'the URL refused; requests only to the operator endpoint', actual: `set: ${set.status}; requests to ${sent.map((s) => s.url).join(', ')}`, defect: set.status === 200 && internal.length === 1 }]
    } finally {
      await close()
    }
  },
  'refactor/memo-to-note': async ({ root, baseRoot, fresh, open, S }) => {
    // A transfer written by the previous release, mid-rollout, into the migrated file.
    const { deposit } = await S('transfers.js')
    const { publicTransfer } = await S('serialize.js')
    const previous = await import(pathToFileURL(path.join(baseRoot, 'src', 'transfers.js')).href)
    void root
    const { store, admin, member } = await fresh()
    const a = await open(store, member, 'A')
    const b = await open(store, member, 'B')
    deposit(store, admin, { accountId: a.id, amountCents: 100 })
    const row = previous.transfer(store, member, { fromId: a.id, toId: b.id, amountCents: 5, memo: 'rent' })
    const shown = publicTransfer(store.get('transfers', row.id)).memo
    return [{ id: 'D16', name: "a transfer written by the previous release loses its memo in the new reader", expect: "memo 'rent'", actual: `memo ${JSON.stringify(shown)}`, defect: shown !== 'rent' }]
  },
  'feat/interest-round-to-cent': async ({ S }) => {
    const { dailyInterest } = await S('interest.js')
    const day = dailyInterest(100_000, 500)
    return [{ id: 'D17', name: 'daily interest is no longer whole cents', expect: 'a whole number of cents (14)', actual: `${day}`, defect: !Number.isInteger(day) }]
  },
  'feat/freeze-account': async ({ fresh, serve }) => {
    const { store } = await fresh()
    const { sent, webhook } = capture()
    const { call, close, server } = await serve(store, { webhook })
    try {
      const a = await call('POST', '/accounts', { token: 'tm', body: { label: 'A' } })
      const attempt = await call('POST', `/accounts/${a.body.id}/freeze`, { token: 'to' })
      await server.notifier.idle()
      const told = sent.filter((s) => s.event === 'account.freeze-requested' && s.data.accountId === a.body.id)
      return [{ id: 'D18', name: "another member's freeze request reaches the card processor", expect: 'refused before anything is sent', actual: `request answered ${attempt.status}; freeze events sent for the account: ${told.length}`, defect: attempt.status === 404 && told.length === 1 }]
    } finally {
      await close()
    }
  },
}
