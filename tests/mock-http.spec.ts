/** Regression for Unicode corruption when the native mock receives split HTTP buffers. */
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
const { readModelRequest }: { readModelRequest(request: Readable): Promise<unknown> } = createRequire(import.meta.url)('../scripts/mock-http.mjs')

it('preserves Chinese reports and emoji at every possible HTTP buffer split', async () => {
  const input = { messages: [{ role: 'user', content: '身份校验、任务执行、结果回传。小林🙂' }] }
  const bytes = Buffer.from(JSON.stringify(input))
  for (let split = 1; split < bytes.length; split++) {
    expect(await readModelRequest(Readable.from([bytes.subarray(0, split), bytes.subarray(split)])), `split ${split}`).toEqual(input)
  }
  expect(await readModelRequest(Readable.from(Array.from(bytes, byte => Buffer.from([byte]))))).toEqual(input)
})

it('rejects an incomplete JSON body instead of accepting partial model context', async () => {
  await expect(readModelRequest(Readable.from([Buffer.from('{"messages":')]))).rejects.toThrow(SyntaxError)
})
