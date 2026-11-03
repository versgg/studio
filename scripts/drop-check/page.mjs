// Runs an expression in Studio's page over its DevTools port and prints the JSON result.
//   node page.mjs PORT 'expression'
const [port, expr] = process.argv.slice(2)
let page
for (let i = 0; i < 100 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {}
  if (!page) await new Promise((r) => setTimeout(r, 200))
}
if (!page) { console.error('no page on the DevTools port'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id !== 1) return
  const r = d.result
  if (r?.exceptionDetails) { console.error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)); process.exit(1) }
  console.log(JSON.stringify(r?.result?.value ?? null))
  process.exit(0)
}
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
