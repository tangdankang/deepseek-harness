import { createInterface } from 'node:readline'

const badHandshake = process.argv.includes('--bad-handshake')
const exitAfterHandshake = process.argv.includes('--exit-after-handshake')
const slowShutdown = process.argv.includes('--slow-shutdown')
const slowReadiness = process.argv.includes('--slow-readiness')
const slowSettings = process.argv.includes('--slow-settings')
process.stderr.write(`fixture token=${'sk-' + 'fixturecredential123'}\n`)
let settingsRevision = 0

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  const respond = (result, delay = 0) => {
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    }, delay)
  }
  if (message.method === 'dsh/initialize') {
    respond(badHandshake
      ? { protocolVersion: 999, serverInfo: { name: 'incompatible' } }
      : { protocolVersion: 1, serverInfo: { name: 'deepseek-harness-host' } }, slowReadiness ? 1000 : 0)
    return
  }
  if (message.method === 'dsh/request') {
    const method = message.params.method
    let value
    if (method === 'host.describe') {
      value = {
        version: 'fixture-version',
        cwd: process.cwd(),
        attachedSessions: 0,
        canOpenPath: false,
      }
    } else if (method === 'settings.describe') {
      value = {
        writable: true,
        hasDocument: true,
        namespaces: [{
          ns: 'permission', schema: {}, value: { defaultPreset: 'confirm-changes' },
          applies: 'live', secrets: [], revision: settingsRevision,
        }],
      }
    } else if (method === 'settings.mutate') {
      settingsRevision += 1
      value = {
        ns: message.params.payload.ns,
        schema: {},
        value: { defaultPreset: message.params.payload.ops[0]?.value },
        applies: 'live',
        secrets: [],
        revision: settingsRevision,
      }
    } else {
      respond({
        type: 'server-response',
        rpcId: message.params.rpcId,
        result: { ok: false, error: { code: 'bad-request', message: `unsupported fixture method ${method}`, details: { issues: [] } } },
      })
      return
    }
    const readinessDelay = slowSettings && method === 'settings.describe'
      ? 3000
      : slowReadiness && (method === 'host.describe' || method === 'settings.describe') ? 1000 : 0
    respond({
      type: 'server-response',
      rpcId: message.params.rpcId,
      result: {
        ok: true,
        value,
      },
    }, readinessDelay)
    if (exitAfterHandshake) setTimeout(() => process.exit(7), 50)
    return
  }
  if (message.method === 'dsh/shutdown') {
    respond({ accepted: true })
    setTimeout(() => process.exit(0), slowShutdown ? 100 : 0)
  }
})
