/** Writes a small deflated zip, enough to stand in for a .pptx or .xlsx in tests. */
import { writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

export function writeZip(path: string, files: Record<string, string>): void {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, dir, end]));
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A presentation whose slide files are numbered opposite to their order. */
export function writePptx(path: string, slides: string[][]): void {
  const files: Record<string, string> = {};
  const ids: string[] = [];
  const rels: string[] = [];
  slides.forEach((paragraphs, i) => {
    const file = slides.length - i;
    files[`ppt/slides/slide${file}.xml`] = `<p:sld><p:cSld><p:spTree>${paragraphs
      .map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)
      .join("")}</p:spTree></p:cSld></p:sld>`;
    ids.push(`<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`);
    rels.push(`<Relationship Id="rId${i + 10}" Type="${REL}/slide" Target="slides/slide${file}.xml"/>`);
  });
  files["ppt/presentation.xml"] = `<p:presentation xmlns:r="${REL}"><p:sldIdLst>${ids.join("")}</p:sldIdLst></p:presentation>`;
  files["ppt/_rels/presentation.xml.rels"] = `<Relationships>${rels.join("")}</Relationships>`;
  writeZip(path, files);
}

/** A one-sheet workbook; `cells` is raw `<c>` XML. */
export function writeXlsx(path: string, sheet: string, cells: string, shared: string[] = []): void {
  writeZip(path, {
    "xl/workbook.xml": `<workbook xmlns:r="${REL}"><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
  });
}
