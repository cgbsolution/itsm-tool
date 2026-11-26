import { describe, expect, it } from "vitest"
import { CsvError, decodeCsvBuffer, detectDelimiter, parseCsv } from "@/lib/cmdb/csv"

describe("CSV parser", () => {
  it("parses simple comma-separated records", () => {
    const r = parseCsv("a,b,c\n1,2,3\n")
    expect(r.delimiter).toBe(",")
    expect(r.rows).toEqual([["a", "b", "c"], ["1", "2", "3"]])
    expect(r.lines).toEqual([1, 2])
  })

  it("handles quoted fields with delimiters, escaped quotes and line breaks", () => {
    const r = parseCsv('code,name,notes\nLAP-1,"Dell, Latitude","He said ""hi""\nsecond line"\nLAP-2,"",plain\n')
    expect(r.rows).toEqual([
      ["code", "name", "notes"],
      ["LAP-1", "Dell, Latitude", 'He said "hi"\nsecond line'],
      ["LAP-2", "", "plain"],
    ])
    // the second record spans lines 2-3, so the third starts on line 4
    expect(r.lines).toEqual([1, 2, 4])
  })

  it("accepts CRLF, lone CR and a missing final newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4").rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"]])
    expect(parseCsv("a,b\r1,2\r").rows).toEqual([["a", "b"], ["1", "2"]])
    expect(parseCsv('a\r\n"x\r\ny"\r\n').rows).toEqual([["a"], ["x\ny"]])
  })

  it("strips a UTF-8 byte-order mark", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("ci_code,name\nA,B\n")])
    const text = decodeCsvBuffer(buf)
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
    expect(parseCsv(text).rows[0]).toEqual(["ci_code", "name"])
    expect(parseCsv("﻿x,y\n1,2").rows[0]).toEqual(["x", "y"])
  })

  it("detects semicolons (Excel in many locales) and tabs", () => {
    const r = parseCsv('ci_code;name;cost\nLAP-1;"Desk; left";1,5\n')
    expect(r.delimiter).toBe(";")
    expect(r.rows[1]).toEqual(["LAP-1", "Desk; left", "1,5"])
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t")
    expect(detectDelimiter('"a,b";c;d\n')).toBe(";")
    expect(detectDelimiter("single\nvalue")).toBe(",")
  })

  it("honours an Excel sep= line", () => {
    const r = parseCsv("sep=;\na;b\n1;2\n")
    expect(r.delimiter).toBe(";")
    expect(r.rows).toEqual([["a", "b"], ["1", "2"]])
    expect(r.lines).toEqual([2, 3])
  })

  it("skips empty lines but keeps rows of empty fields", () => {
    const r = parseCsv("a,b\n\n1,2\n\r\n\n,\n3,4\n\n")
    expect(r.rows).toEqual([["a", "b"], ["1", "2"], ["", ""], ["3", "4"]])
    expect(r.lines).toEqual([1, 3, 6, 7])
  })

  it("keeps a quoted empty value as a record", () => {
    expect(parseCsv('a\n""\n').rows).toEqual([["a"], [""]])
  })

  it("treats stray quotes inside unquoted fields as text", () => {
    expect(parseCsv('a,b\n12" monitor,x\n').rows[1]).toEqual(['12" monitor', "x"])
  })

  it("reports an unterminated quoted field with its line", () => {
    expect(() => parseCsv('a,b\n1,"open\n2,3\n')).toThrow(CsvError)
    try {
      parseCsv('a,b\n1,"open\n2,3\n')
    } catch (e) {
      expect((e as CsvError).line).toBe(2)
    }
  })

  it("reads Windows-1252 when the bytes are not UTF-8, and refuses binary", () => {
    const latin = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9]) // "name\nCafé" in cp1252
    expect(parseCsv(decodeCsvBuffer(latin)).rows[1]).toEqual(["Café"])
    expect(() => decodeCsvBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toThrow(CsvError)
  })

  it("decodes UTF-16 with a byte-order mark", () => {
    const body = Buffer.from("a\tb\n1\t2\n", "utf16le")
    const text = decodeCsvBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), body]))
    expect(parseCsv(text).rows).toEqual([["a", "b"], ["1", "2"]])
  })
})
