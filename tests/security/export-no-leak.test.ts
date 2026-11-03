/**
 * F-05 no-leak proof: a counterpart workbook can carry other people's data outside the Data rows (comments, custom
 * XML, label metadata, document properties, defined names, pivot caches, embedded objects, extra hidden sheets).
 * Whatever the export mode, none of it and none of the excluded rows may reach the exported package. Every part of
 * the output is decompressed and searched. All data is synthetic; the canary strings are made up.
 */
import { describe, expect, it } from 'vitest';
import type { ObservedPerson } from '../../src/shared/domain/types.ts';
import { exportInvestc, extractBlankTemplate } from '../../src/main/formats/investc/export.ts';
import { parseInvestc } from '../../src/main/formats/investc/parse.ts';
import { decodeUtf8, readZip, WorkbookPatcher } from '../../src/main/formats/ooxml/index.ts';
import { validatePackageStructure } from '../../tools/ooxml-validate/structural.ts';
import { fixtureBytes, TEMPLATE } from '../unit/formats/helpers.ts';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CANARY = {
  customXml: 'CanaryCustomXmlQ7',
  customProp: 'CanaryCustomPropQ7',
  label: 'CanaryLabelInfoQ7',
  comment: 'CanaryCommentTextQ7',
  commentAuthor: 'CanaryCommentAuthorQ7',
  person: 'CanaryThreadPersonQ7',
  title: 'CanaryDocTitleQ7',
  author: 'CanaryDocAuthorQ7',
  company: 'CanaryCompanyQ7',
  definedName: 'CanaryDefinedNameQ7',
  sharing: 'CanaryFileSharingUserQ7',
  pivot: 'CanaryPivotCacheQ7',
  ole: 'CanaryEmbeddedObjectQ7',
  sheet4: 'CanaryHiddenSheetQ7',
};

const text = (p: WorkbookPatcher, part: string): string => decodeUtf8(p.get(part) as Uint8Array);
const edit = (p: WorkbookPatcher, part: string, fn: (x: string) => string): void => {
  const before = text(p, part);
  const after = fn(before);
  if (after === before) throw new Error(`edit of ${part} changed nothing`);
  p.replacePart(part, after);
};
const override = (part: string, type: string) =>
  `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`;
const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;

/** Extras that the whitelist knows how to drop: the export stays in filter-original mode. */
function addDroppableExtras(p: WorkbookPatcher, excludedName: string): void {
  p.addPart('customXml/item1.xml', `${XML}<root><v>${CANARY.customXml}</v><v>${excludedName}</v></root>`);
  p.addPart(
    'customXml/itemProps1.xml',
    `${XML}<ds:datastoreItem ds:itemID="{00000000-0000-4000-8000-0000000000AA}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"/>`,
  );
  p.addPart(
    'customXml/_rels/item1.xml.rels',
    `${XML}<Relationships xmlns="${RELS_NS}">${rel('rId1', `${R}/customXmlProps`, 'itemProps1.xml')}</Relationships>`,
  );
  p.addPart(
    'docProps/custom.xml',
    `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Note"><vt:lpwstr>${CANARY.customProp}</vt:lpwstr></property></Properties>`,
  );
  p.addPart(
    'docMetadata/LabelInfo.xml',
    `${XML}<clbl:labelList xmlns:clbl="x"><clbl:label id="${CANARY.label}"/></clbl:labelList>`,
  );
  p.addPart(
    'xl/comments1.xml',
    `${XML}<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>${CANARY.commentAuthor}</author></authors><commentList><comment ref="C11" authorId="0"><text><t>${CANARY.comment} ${excludedName}</t></text></comment></commentList></comments>`,
  );
  p.addPart(
    'xl/drawings/vmlDrawing1.vml',
    `<xml><x:ClientData ObjectType="Note"><x:Row>10</x:Row></x:ClientData></xml>`,
  );
  p.addPart(
    'xl/worksheets/_rels/sheet2.xml.rels',
    `${XML}<Relationships xmlns="${RELS_NS}">${rel('rId1', `${R}/comments`, '../comments1.xml')}${rel('rId2', `${R}/vmlDrawing`, '../drawings/vmlDrawing1.vml')}</Relationships>`,
  );
  p.addPart(
    'xl/persons/person.xml',
    `${XML}<personList xmlns="x"><person displayName="${CANARY.person}" id="{1}"/></personList>`,
  );
  edit(p, 'xl/worksheets/sheet2.xml', (x) => x.replace('<extLst>', '<legacyDrawing r:id="rId2"/><extLst>'));
  edit(p, '_rels/.rels', (x) =>
    x.replace(
      '</Relationships>',
      rel('rId8', `${R}/custom-properties`, 'docProps/custom.xml') +
        rel(
          'rId9',
          'http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels',
          'docMetadata/LabelInfo.xml',
        ) +
        '</Relationships>',
    ),
  );
  edit(p, 'xl/_rels/workbook.xml.rels', (x) =>
    x.replace(
      '</Relationships>',
      rel('rId20', `${R}/customXml`, '../customXml/item1.xml') +
        rel('rId21', 'http://schemas.microsoft.com/office/2017/10/relationships/person', 'persons/person.xml') +
        '</Relationships>',
    ),
  );
  edit(p, '[Content_Types].xml', (x) =>
    x.replace(
      '</Types>',
      '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>' +
        override('customXml/itemProps1.xml', 'customXmlProperties+xml') +
        override('docProps/custom.xml', 'custom-properties+xml') +
        override('xl/comments1.xml', 'spreadsheetml.comments+xml') +
        override('xl/persons/person.xml', 'spreadsheetml.person+xml') +
        '</Types>',
    ),
  );
  edit(p, 'docProps/core.xml', (x) =>
    x
      .replace(
        '<dc:creator>VSS</dc:creator>',
        `<dc:title>${CANARY.title}</dc:title><dc:creator>${CANARY.author}</dc:creator>`,
      )
      .replace('<cp:lastModifiedBy>VSS</cp:lastModifiedBy>', `<cp:lastModifiedBy>${CANARY.author}</cp:lastModifiedBy>`),
  );
  edit(p, 'docProps/app.xml', (x) => x.replace('<DocSecurity>', `<Company>${CANARY.company}</Company><DocSecurity>`));
  edit(p, 'xl/workbook.xml', (x) =>
    x
      .replace('<workbookPr/>', `<fileSharing userName="${CANARY.sharing}"/><workbookPr/>`)
      .replace(
        '</sheets>',
        `</sheets><definedNames><definedName name="Note">"${CANARY.definedName}"</definedName><definedName name="_xlnm.Print_Area" localSheetId="1">Data!$A$1:$S$15</definedName><definedName name="UnitTypes">'Reference Data'!$A$2:$A$5</definedName></definedNames>`,
      ),
  );
}

/** Extras the whitelist does not recognise: filter-original must fall back to the vault template. */
function addUnknownExtras(p: WorkbookPatcher, excludedName: string): void {
  p.addPart(
    'xl/pivotCache/pivotCacheDefinition1.xml',
    `${XML}<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cacheFields count="1"><cacheField name="${CANARY.pivot}"><sharedItems><s v="${excludedName}"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>`,
  );
  p.addPart('xl/embeddings/oleObject1.bin', new TextEncoder().encode(`OLE ${CANARY.ole} ${excludedName}`));
  p.addPart(
    'xl/worksheets/sheet4.xml',
    `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${CANARY.sheet4} ${excludedName}</t></is></c></row></sheetData></worksheet>`,
  );
  edit(p, 'xl/_rels/workbook.xml.rels', (x) =>
    x.replace(
      '</Relationships>',
      rel('rId30', `${R}/pivotCacheDefinition`, 'pivotCache/pivotCacheDefinition1.xml') +
        rel('rId31', `${R}/worksheet`, 'worksheets/sheet4.xml') +
        '</Relationships>',
    ),
  );
  edit(p, 'xl/workbook.xml', (x) =>
    x
      .replace('</sheets>', '<sheet name="Notes" sheetId="4" state="hidden" r:id="rId31"/></sheets>')
      .replace('<calcPr', '<pivotCaches><pivotCache cacheId="1" r:id="rId30"/></pivotCaches><calcPr'),
  );
  edit(p, '[Content_Types].xml', (x) =>
    x.replace(
      '</Types>',
      '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>' +
        override('xl/pivotCache/pivotCacheDefinition1.xml', 'spreadsheetml.pivotCacheDefinition+xml') +
        override('xl/worksheets/sheet4.xml', 'spreadsheetml.worksheet+xml') +
        '</Types>',
    ),
  );
}

/** Every part decompressed and decoded (binary parts as latin1), joined. */
function allText(bytes: Uint8Array): string {
  const pkg = readZip(bytes);
  return pkg.order
    .map((n) => {
      const b = pkg.parts.get(n) as Uint8Array;
      return `${n}\n${/\.(xml|rels|vml)$/i.test(n) ? decodeUtf8(b) : Buffer.from(b).toString('latin1')}`;
    })
    .join('\n');
}

const FIELDS: (keyof ObservedPerson)[] = [
  'surname',
  'name1',
  'name2',
  'name3',
  'name4',
  'passport',
  'nationalId',
  'fatherName',
  'motherName',
  'pobCity',
  'pobState',
];

function scenario() {
  const source = fixtureBytes('requests/req-001-basic.xlsx');
  const parsed = parseInvestc(source);
  const keepUnit = parsed.units[0]!.name;
  const included = parsed.people.filter((p) => p.unitName === keepUnit);
  const excluded = parsed.people.filter((p) => p.unitName !== keepUnit);
  expect(included.length).toBeGreaterThan(0);
  expect(excluded.length).toBeGreaterThan(0);
  const keptValues = new Set(included.flatMap((p) => FIELDS.map((f) => String(p[f]))));
  const excludedStrings = [parsed.units[1]!.name, ...excluded.flatMap((p) => FIELDS.map((f) => String(p[f])))].filter(
    (s) => s.trim().length >= 3 && !keptValues.has(s),
  );
  expect(excludedStrings.length).toBeGreaterThan(6);
  expect(allText(source)).toContain(excludedStrings[0]); // the needles are really in the source
  const name = excluded[0]!.surname;
  const droppable = WorkbookPatcher.fromBytes(source);
  addDroppableExtras(droppable, name);
  const unknown = WorkbookPatcher.fromBytes(droppable.toBytes());
  addUnknownExtras(unknown, name);
  return {
    parsed,
    included,
    needles: [...excludedStrings, ...Object.values(CANARY)],
    droppable: droppable.toBytes(),
    unknown: unknown.toBytes(),
  };
}

function assertClean(bytes: Uint8Array, needles: readonly string[]): void {
  const all = allText(bytes);
  const found = needles.filter((n) => all.includes(n));
  expect(found).toEqual([]);
  expect(validatePackageStructure(bytes)).toEqual([]);
}

describe('F-05: nothing of other people survives an export', () => {
  it('the canary sources really carry every canary', () => {
    const s = scenario();
    const all = allText(s.unknown);
    for (const c of Object.values(CANARY)) expect(all).toContain(c);
  });

  it('filter-original drops known extras (comments, custom XML, labels, properties, names) and keeps filtering', () => {
    const s = scenario();
    const out = exportInvestc({
      mode: 'filter-original',
      source: s.droppable,
      units: s.parsed.units,
      people: s.included,
    });
    expect(out.modeUsed).toBe('filter-original');
    expect(out.issues).toMatchObject([{ severity: 'info', message: expect.stringContaining('not carried over') }]);
    assertClean(out.bytes, s.needles);
    const again = parseInvestc(out.bytes);
    expect(again.people.map((p) => p.surname)).toEqual(s.included.map((p) => p.surname));
    expect(allText(out.bytes)).toContain(`'Reference Data'!$A$2:$A$5`); // the reference-only defined name stays
  });

  it('filter-original with unknown parts (pivot cache, embedding, hidden sheet) regenerates from the vault template', () => {
    const s = scenario();
    const template = extractBlankTemplate(s.droppable).bytes;
    const out = exportInvestc({
      mode: 'filter-original',
      source: s.unknown,
      template,
      units: s.parsed.units,
      people: s.included,
    });
    expect(out.modeUsed).toBe('regenerate');
    expect(out.issues).toMatchObject([{ code: 'TEMPLATE_VERSION_UNKNOWN', severity: 'info' }]);
    assertClean(out.bytes, s.needles);
  });

  it('a pivot cache alone (no extra sheet) is enough to refuse filtering', () => {
    const source = fixtureBytes('requests/req-001-basic.xlsx');
    const parsed = parseInvestc(source);
    const p = WorkbookPatcher.fromBytes(source);
    addUnknownExtras(p, 'x');
    edit(p, 'xl/workbook.xml', (x) => x.replace('<sheet name="Notes" sheetId="4" state="hidden" r:id="rId31"/>', ''));
    const out = exportInvestc({ mode: 'filter-original', source: p.toBytes(), template: TEMPLATE(), ...parsed });
    expect(out.modeUsed).toBe('regenerate');
    expect(out.issues[0]?.message).toMatch(/parts VSS does not carry over: .*pivotCache/);
    expect(allText(out.bytes)).not.toContain(CANARY.pivot);
  });

  it('regenerate from a template captured from the canary source carries nothing of it', () => {
    const s = scenario();
    const captured = extractBlankTemplate(s.droppable);
    assertClean(captured.bytes, [...s.needles, ...s.included.map((p) => p.surname)]);
    for (const source of [s.droppable, s.unknown]) {
      const out = exportInvestc({
        mode: 'regenerate',
        source,
        template: captured.bytes,
        units: s.parsed.units,
        people: s.included,
      });
      expect(out.modeUsed).toBe('regenerate');
      assertClean(out.bytes, s.needles);
    }
  });

  it('a workbook with unknown parts is refused as a template', () => {
    const s = scenario();
    expect(() => extractBlankTemplate(s.unknown)).toThrow(/cannot be used as a template/);
  });
});
