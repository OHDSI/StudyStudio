/**
 * CDISC Define-XML stylesheets shipped next to define.xml so a reviewer can open it in a browser.
 *
 * The CDISC files are not committed to this repository: they are distributed by CDISC with the
 * Define-XML packages and carry their own terms. Put `define2-1-0.xsl` and/or `define2-0-0.xsl` in
 * src/lib/cdisc/stylesheets/ before building; when a file is present it is inlined into the build,
 * archived in the submission ZIP and referenced from define.xml by an xml-stylesheet instruction.
 * When it is absent, define.xml is produced without that instruction.
 */
import type { DefineXmlVersion } from './defineXml'

export interface DefineStylesheet {
  /** File name, used as the archive path and the xml-stylesheet href. */
  name: string
  text: string
}

export const STYLESHEET_NAMES: Record<DefineXmlVersion, string> = { '2.1': 'define2-1-0.xsl', '2.0': 'define2-0-0.xsl' }

const bundled = import.meta.glob('./stylesheets/*.xsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export function bundledStylesheet(version: DefineXmlVersion): DefineStylesheet | undefined {
  const name = STYLESHEET_NAMES[version]
  const text = bundled[`./stylesheets/${name}`]
  return text ? { name, text } : undefined
}
