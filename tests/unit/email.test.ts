import { describe, expect, it } from "vitest"
import { simpleParser } from "mailparser"
import { isAutomatic, stripQuoted } from "@/lib/email/inbound"

describe("email-to-ticket helpers", () => {
  it("keeps only the new part of a reply", () => {
    const text = "Thanks, that worked.\n\nOn Tue, 26 Nov 2026 at 10:00, Service Desk <desk@example.com> wrote:\n> Please try again\n> Regards"
    expect(stripQuoted(text)).toBe("Thanks, that worked.")
    expect(stripQuoted("Hi\n-----Original Message-----\nFrom: x")).toBe("Hi")
    expect(stripQuoted("line one\n> quoted\nline two")).toBe("line one\nline two")
  })

  it("recognises auto-replies and bounces", async () => {
    const ooo = await simpleParser("From: a@example.com\r\nAuto-Submitted: auto-replied\r\nSubject: Out of office\r\n\r\nAway")
    expect(isAutomatic(ooo)).toBe(true)
    const bounce = await simpleParser("From: MAILER-DAEMON@example.com\r\nSubject: Undeliverable\r\n\r\nx")
    expect(isAutomatic(bounce)).toBe(true)
    const human = await simpleParser("From: Asha <asha@example.com>\r\nSubject: [INC0001001] Re: VPN\r\n\r\nStill broken")
    expect(isAutomatic(human)).toBe(false)
  })
})
