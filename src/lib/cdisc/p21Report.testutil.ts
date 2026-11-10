import * as XLSX from 'xlsx'

/**
 * A workbook laid out as the Pinnacle 21 Community report (CLI 1.0.9 / GUI 4.x): Validation Summary,
 * Dataset Summary, Issue Summary. Built here rather than committed, as real reports carry the
 * validator's rule texts.
 */
export function p21Workbook(o: { engine: string; config: string; datasets?: string[]; issues: [source: string, id: string, message: string, severity: string, found: number][]; problems?: string[] }): Uint8Array {
  const wb = XLSX.utils.book_new()
  const summary: unknown[][] = [
    ['Pinnacle 21 Validator Report'],
    [`Configuration: C:\\Users\\someone\\AppData\\Local\\Programs\\Pinnacle 21 Community\\resources\\app.asar.unpacked\\components\\lib\\configs\\${o.engine.split(' ')[1]}\\${o.config}.xml`],
    ['Define.xml: C:\\Users\\someone\\AppData\\Local\\Temp\\package\\define.xml'],
    ['Generated: 2026-11-11T02:06:28+09:00'],
    ['Standard: null'],
    ['CDISC ADaM CT Version: 2026-03-27'],
    [`Validation Engine Name: ${o.engine}`],
    ['Software Version: 1.0.9'],
    ...(o.problems?.length ? [['Problems with your Validator installation detected\n which may cause inaccurate validation results'], ['Problem', 'Details', 'Link'], ...o.problems.map((p) => [p, 'details', 'https://example.org'])] : []),
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Validation Summary')
  const head = ['Domain', 'Label', 'Class', 'Source', 'Records', 'Rejects', 'Errors', 'Warnings', 'Notices']
  const ds = o.datasets ?? []
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Pinnacle 21 Validator Report'],
      ...(ds.length
        ? [['Processed Sources'], head, ['GLOBAL', 'Global Metadata', '--', '--', 0, 1, 0, 0, 0], ...ds.map((d) => [d, `${d.toLowerCase()} label`, 'ADAM OTHER', `${d.toLowerCase()}.xpt`, 3, 0, 0, 1, 0]), ['Total', null, null, null, 3 * ds.length, 1, 0, ds.length, 0], ['Unprocessed Sources'], head, ...ds.map((d) => [d, 'Unknown', 'Unknown', 'Missing', null, 0, 0, 0, 0])]
        : []),
    ]),
    'Dataset Summary',
  )
  const issueRows: unknown[][] = [['Pinnacle 21 Validator Report'], ['Issue Summary'], ['Source', 'Pinnacle 21 ID', 'Message', 'Severity', 'Found']]
  let last = ''
  for (const [source, id, message, severity, found] of o.issues) {
    if (source !== last) issueRows.push([source])
    last = source
    issueRows.push([null, id, message, severity, found])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(issueRows), 'Issue Summary')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Domain', 'Record', 'Count']]), 'Details')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
