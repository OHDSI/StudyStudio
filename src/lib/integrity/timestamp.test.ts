import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './hasher'
import { timeStampRequest, verifyTimestamp } from './timestamp'

// Tokens from `openssl ts -reply` with a test TSA (RSA 2048 and ECDSA P-256 keys, ESS signing-certificate v2),
// over study_config.json. `openssl ts -verify` accepts both against the test root.
const dir = path.join(__dirname, 'testdata')
const read = (f: string) => new Uint8Array(readFileSync(path.join(dir, f)))
const DATA_SHA256 = '9997e2f2e50c01d8690101059d372350e0d77496c34f7c69d0351c03d3919920'
const RSA_CERT_SHA256 = 'fad288c53a350104920588abe8ba36d8cd805faa01b039eabc742394409b45c7'

describe('RFC 3161 time-stamp tokens', () => {
  it('fixture digest is the SHA-256 of study_config.json', async () => {
    expect(await sha256Hex(read('study_config.json'))).toBe(DATA_SHA256)
  })

  it('verifies an RSA token and reads the TSA time, name and certificate', async () => {
    const c = await verifyTimestamp(read('rsa.tsr'), DATA_SHA256)
    expect(c).toMatchObject({ valid: true, imprint: DATA_SHA256, policy: '1.2.3.4.1', tsa: 'Test TSA rsa (Study Studio Test)', tsaCertSha256: RSA_CERT_SHA256 })
    expect(c.genTime).toMatch(/^2026-11-17T\d{2}:\d{2}:\d{2}\.000Z$/)
  })

  it('verifies an ECDSA P-256 token', async () => {
    expect(await verifyTimestamp(read('ec.tsr'), DATA_SHA256)).toMatchObject({ valid: true, tsa: 'Test TSA ec (Study Studio Test)' })
  })

  it('rejects a token for other data', async () => {
    const c = await verifyTimestamp(read('rsa.tsr'), '0'.repeat(64))
    expect(c).toMatchObject({ valid: false, error: 'The token covers different data' })
    expect(c.genTime).toBeDefined()
  })

  it('rejects a token without the TSA certificate', async () => {
    expect((await verifyTimestamp(read('nocert.tsr'), DATA_SHA256)).error).toMatch(/certificate is not in the token/)
  })

  it('rejects a token whose signed content was changed', async () => {
    const t = read('rsa.tsr')
    // Flip a byte of the genTime inside TSTInfo: the signed message digest no longer matches.
    const i = Buffer.from(t).indexOf(Buffer.from('2026'))
    t[i + 3] ^= 1
    expect((await verifyTimestamp(t, DATA_SHA256)).valid).toBe(false)
  })

  it('rejects garbage without throwing', async () => {
    expect((await verifyTimestamp(new Uint8Array([1, 2, 3]), DATA_SHA256)).valid).toBe(false)
  })

  it('writes the same request as openssl ts -query -sha256 -cert -no_nonce', () => {
    // Fixed bytes: version 1, SHA-256 imprint, certReq TRUE.
    const expected = '3039020101303130' + '0d060960864801650304020105000420' + DATA_SHA256 + '0101ff'
    expect(Buffer.from(timeStampRequest(DATA_SHA256)).toString('hex')).toBe(expected)
    let fromOpenssl: Buffer
    try {
      const out = path.join(mkdtempSync(path.join(tmpdir(), 'tsq-')), 'q.tsq')
      execFileSync('openssl', ['ts', '-query', '-digest', DATA_SHA256, '-sha256', '-cert', '-no_nonce', '-out', out], { stdio: 'ignore' })
      fromOpenssl = readFileSync(out)
    } catch {
      return // openssl not installed
    }
    expect(fromOpenssl.toString('hex')).toBe(expected)
  })
})
