import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DefineXmlVersion } from './defineXml'

/**
 * Validates define.xml against the CDISC Define-XML schemas with xmllint. `schemas` is a folder laid out
 * as in cdisc-org/data-definition-engine (define/2.1, define/2.0, odm/1.3.2). Returns xmllint's stdout
 * ('' when valid); throws with its messages otherwise.
 */
const xsd: Record<DefineXmlVersion, string> = { '2.1': 'define/2.1/define2-1-0.xsd', '2.0': 'define/2.0/define2-0-0.xsd' }

export function xmllint(schemas: string, version: DefineXmlVersion, xml: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'define-xsd-')), `define-${version}.xml`)
  writeFileSync(file, xml)
  try {
    return execFileSync('xmllint', ['--noout', '--schema', path.join(schemas, xsd[version]), file], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error(`define.xml (v${version}) is not schema-valid:\n${err.stderr || err.message}`)
  }
}
