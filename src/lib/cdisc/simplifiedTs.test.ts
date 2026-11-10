import { describe, expect, it } from 'vitest'
import { simplifiedTsFor, writeSimplifiedTs } from './simplifiedTs'
import { readXpt } from './xpt'

describe('FDA simplified ts.xpt', () => {
  it('uses example B (TSVALNF = "NA") unless the study started on or before 2016-12-17', () => {
    expect(simplifiedTsFor()).toEqual({ example: 'B', studyStartDate: null })
    expect(simplifiedTsFor(' ')).toEqual({ example: 'B', studyStartDate: null })
    expect(simplifiedTsFor('2024-05-01')).toEqual({ example: 'B', studyStartDate: null })
    expect(simplifiedTsFor('2016-12-17')).toEqual({ example: 'A', studyStartDate: '2016-12-17' })
    expect(simplifiedTsFor('2015-03-02')).toEqual({ example: 'A', studyStartDate: '2015-03-02' })
    for (const bad of ['2015-02-30', '2015/03/02', '20150302']) expect(() => simplifiedTsFor(bad)).toThrow('not a date')
  })

  it('writes the four variables and one SSTDTC row', () => {
    const b = readXpt(writeSimplifiedTs('OHDSI-STUDY-1', simplifiedTsFor()))
    expect(b).toMatchObject({ name: 'TS', label: 'Trial Summary' })
    expect(b.variables.map((v) => [v.name, v.label, v.type])).toEqual([
      ['STUDYID', 'Study Identifier', 'char'],
      ['TSPARMCD', 'Trial Summary Parameter Short Name', 'char'],
      ['TSVAL', 'Parameter Value', 'char'],
      ['TSVALNF', 'Parameter Null Flavor', 'char'],
    ])
    // Blank text reads back as null (missing).
    expect(b.rows).toEqual([['OHDSI-STUDY-1', 'SSTDTC', null, 'NA']])
    const a = readXpt(writeSimplifiedTs('OHDSI-STUDY-1', simplifiedTsFor('2015-03-02')))
    expect(a.rows).toEqual([['OHDSI-STUDY-1', 'SSTDTC', '2015-03-02', null]])
  })
})
