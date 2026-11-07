// Vmake text removal on the user's own Vmake account. The flow, as vmake.ai's own page uses it:
//   POST /uploader/sign.json                    -> upload params
//   GET  strategy.stariidata.com/upload/policy  -> short-lived bucket credentials
//   PUT  the file into the bucket               -> S3 signature v2, x-amz-date in RFC 1123 form
//   POST /vm/tool/purchase.json                 -> charges credits, returns record + task id
//   POST /vm/tool/query.json                    -> poll until status 2, then take the result

import crypto from 'node:crypto'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { effectOf, type VmakeOffer } from './vmake-catalog'

const API = 'https://wapi.vmake.ai'
const TOOL = 'watermark-remover'
// The same client as the working server code sends.
const CLIENT_OS = 'Linux'
const UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36'

export class VmakeAuthError extends Error {}
export class VmakeError extends Error {}
/** No answer from Vmake at all (no network, a timeout, an HTTP error): the job on Vmake isn't affected. */
export class VmakeUnreachable extends VmakeError {}

function timezone() {
  const m = -new Date().getTimezoneOffset()
  const sign = m >= 0 ? '+' : '-'
  const a = Math.abs(m)
  return `GMT${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

export class Vmake {
  private headers: Record<string, string>

  constructor(private token: string) {
    if (!token?.trim()) throw new VmakeAuthError('Paste your Vmake access token first.')
    this.token = token.trim()
    this.headers = {
      origin: 'https://vmake.ai',
      referer: 'https://vmake.ai/',
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'x-client-timezone': timezone(),
      'access-token': this.token,
    }
  }

  private async call(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}): Promise<any> {
    let url = API + path
    let body: string | undefined
    if (method === 'GET') url += `?${new URLSearchParams(Object.entries({ ...params, client_os: CLIENT_OS }).map(([k, v]) => [k, String(v)]))}`
    else body = JSON.stringify({ ...params, client_os: CLIENT_OS })
    let payload: any
    try {
      const r = await fetch(url, { method, body, headers: { ...this.headers, ...(body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(60_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      payload = await r.json()
    } catch (e) {
      throw new VmakeUnreachable(`Vmake did not answer: ${String((e as Error).message).slice(0, 200)}`)
    }
    const meta = payload?.meta ?? {}
    if (meta.code === 10022) throw new VmakeAuthError('Vmake rejected that token: it has expired. Copy a fresh one.')
    if (meta.code !== 0) throw new VmakeError(meta.msg || meta.error || `Vmake refused ${path}`)
    return payload.response
  }

  /** The balance and every model on offer with its price (vmake-catalog.ts keeps them). */
  async account(): Promise<{ balance: number | null; offers: VmakeOffer[] }> {
    const [info, config] = await Promise.all([this.call('GET', '/account/info.json', { features: 'contract' }), this.call('GET', '/vm/tool/purchase_config.json', { tool_type: TOOL, client_language: 'en' })])
    const text = (...v: unknown[]) => v.find((x): x is string => typeof x === 'string' && !!x.trim())?.trim()
    const offers: VmakeOffer[] = (config?.list ?? [])
      .filter((item: any) => typeof item?.effect_model === 'string' && item.effect_model.startsWith('video_'))
      .map((item: any) => ({
        effect: item.effect_model,
        credits: item.product_price ?? null,
        durationLimit: item.duration_limit || 0,
        remain: item.remain ?? null,
        name: text(item.name, item.title, item.effect_name, item.model_name),
        note: text(item.desc, item.description, item.sub_title, item.subtitle),
      }))
    const balance = info?.balance_detail?.total_amount ?? config?.balance ?? null
    return { balance, offers }
  }

  /** Puts the file in Vmake's bucket; returns what `purchase` takes. Costs nothing. */
  async upload(file: string): Promise<string> {
    const { params } = await this.call('POST', '/uploader/sign.json', { count: 1, suffix: 'mp4', tool_type: TOOL, source: '' })
    const p = await fetch(`https://strategy.stariidata.com/upload/policy?${new URLSearchParams(params)}`, {
      headers: { 'Access-Token': this.token, Origin: 'https://vmake.ai', 'User-Agent': UA },
      signal: AbortSignal.timeout(30_000),
    })
    if (!p.ok) throw new VmakeError(`Vmake's upload service refused (HTTP ${p.status}).`)
    const oss = (await p.json())[0].oss
    const { credentials: cred, bucket, key } = oss
    const host = oss.use_virtual_host ? String(oss.url).replace('://', `://${bucket}.`) : `${oss.url}/${bucket}`
    // S3 signature v2, as the browser uploader does.
    const date = new Date().toUTCString()
    const type = 'video/mp4'
    const toSign = `PUT\n\n${type}\n\nx-amz-date:${date}\nx-amz-security-token:${cred.session_token}\n/${bucket}/${key}`
    const sig = crypto.createHmac('sha1', cred.secret_key).update(toSign).digest('base64')
    const size = fs.statSync(file).size
    const r = await fetch(`${host}/${key}`, {
      method: 'PUT',
      body: Readable.toWeb(fs.createReadStream(file)) as ReadableStream,
      // @ts-expect-error Node's fetch needs this to stream a request body.
      duplex: 'half',
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'x-amz-date': date, 'x-amz-security-token': cred.session_token, Authorization: `AWS ${cred.access_key}:${sig}` },
      signal: AbortSignal.timeout(15 * 60_000),
    })
    if (r.status !== 200) throw new VmakeError(`The upload to Vmake failed (HTTP ${r.status}).`)
    return oss.data
  }

  /**
   * Charges the credits and starts the job. Returns the record and task to follow it by,
   * which keep working after a restart (`query` needs nothing else), so they're saved with
   * the job (vmake-jobs.ts).
   */
  async purchase(source: string, title: string, modelKey: string): Promise<{ recordId: VmakeRef; taskId: VmakeRef }> {
    const model = effectOf(modelKey)
    if (!model) throw new VmakeError('Unknown removal model.')
    const job = await this.call('POST', '/vm/tool/purchase.json', { tool_type: TOOL, url: source, title: title.slice(0, 120) || 'video', effect_model: model, support_h_265: 1 })
    const recordId = job?.record_id ?? job?.id
    const taskId = job?.task_id ?? job?.purchased_list?.[0]?.task_id
    if (!recordId || !taskId) throw new VmakeError(`Vmake accepted the job but returned no task to follow: ${JSON.stringify(job).slice(0, 200)}`)
    return { recordId, taskId }
  }

  /** Where a job is: status 0 or 1 while it works, 2 when done (with `result`, a link to the video); anything else failed. */
  async query(recordId: VmakeRef, taskId: VmakeRef): Promise<VmakeStatus> {
    const { list } = await this.call('POST', '/vm/tool/query.json', { record_id: [recordId] })
    const purchased: any[] = list?.[0]?.purchased_list ?? []
    const t = purchased.find((p) => p.task_id === taskId) ?? purchased[purchased.length - 1] ?? {}
    const pct = Number(t.progress ?? t.percent ?? 0)
    return { status: Number(t.status), progress: Number.isFinite(pct) ? pct : 0, result: t.result || undefined }
  }

  /** Downloads a finished job's video to `out`. */
  async download(result: string, out: string, signal: AbortSignal) {
    const r = await fetch(result, { signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]) })
    if (!r.ok || !r.body) throw new VmakeError(`Couldn't download the cleaned video (HTTP ${r.status}).`)
    await pipeline(Readable.fromWeb(r.body as any), fs.createWriteStream(out))
  }
}

/** Vmake's ids for a record and a task, kept as Vmake sent them (number or string). */
export type VmakeRef = string | number

export interface VmakeStatus {
  status: number
  /** 0–100. */
  progress: number
  result?: string
}
