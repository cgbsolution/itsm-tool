import { describe, expect, it } from "vitest"
import { addSlaMinutes, slaMinutesBetween, deadlineAfterPause, formatMinutes, type WorkCalendar } from "@/lib/itsm/clock"
import { priorityFromMatrix, DEFAULT_MATRIX } from "@/lib/itsm/vocab"

const IST: WorkCalendar = { timezone: "Asia/Kolkata", work_days: [1, 2, 3, 4, 5], work_start: "09:00", work_end: "18:00", holidays: ["2026-12-25"] }

describe("SLA clock (ported legacy maths)", () => {
  it("runs around the clock without a calendar", () => {
    const from = new Date("2026-11-27T10:00:00Z")
    expect(addSlaMinutes(from, 90, null).toISOString()).toBe("2026-11-27T11:30:00.000Z")
  })

  it("counts only business hours in the calendar's time zone", () => {
    // Friday 17:30 IST + 60 business minutes → Monday 09:30 IST
    const from = new Date("2026-11-27T12:00:00Z") // 17:30 IST, Friday
    const due = addSlaMinutes(from, 60, IST)
    expect(due.toISOString()).toBe("2026-11-30T04:00:00.000Z") // Mon 09:30 IST
  })

  it("starts the clock at opening time when raised before hours", () => {
    const from = new Date("2026-11-30T01:00:00Z") // Mon 06:30 IST
    expect(addSlaMinutes(from, 30, IST).toISOString()).toBe("2026-11-30T04:00:00.000Z") // 09:30 IST
  })

  it("skips holidays", () => {
    const from = new Date("2026-12-24T12:00:00Z") // Thu 17:30 IST; Fri 25 Dec is a holiday
    expect(addSlaMinutes(from, 60, IST).toISOString()).toBe("2026-12-28T04:00:00.000Z") // Mon 09:30
  })

  it("measures business minutes between instants", () => {
    const a = new Date("2026-11-27T12:00:00Z") // Fri 17:30
    const b = new Date("2026-11-30T04:00:00Z") // Mon 09:30
    expect(slaMinutesBetween(a, b, IST)).toBe(60)
    expect(slaMinutesBetween(b, a, IST)).toBe(0)
  })

  it("gives back the remaining time after a pause", () => {
    const due = new Date("2026-11-27T12:00:00Z")
    const paused = new Date("2026-11-27T11:00:00Z")
    const resumed = new Date("2026-11-27T15:00:00Z")
    expect(deadlineAfterPause(due, paused, resumed, null).toISOString()).toBe("2026-11-27T16:00:00.000Z")
    // a deadline already missed when paused stays missed
    expect(deadlineAfterPause(paused, due, resumed, null).toISOString()).toBe(paused.toISOString())
  })

  it("formats durations", () => {
    expect(formatMinutes(15)).toBe("15 min")
    expect(formatMinutes(90)).toBe("1 h 30 min")
    expect(formatMinutes(1440 * 2 + 240)).toBe("2 d 4 h")
  })
})

describe("priority matrix", () => {
  it("uses the tenant matrix", () => {
    expect(priorityFromMatrix(DEFAULT_MATRIX, "high", "high")).toBe("critical")
    expect(priorityFromMatrix(DEFAULT_MATRIX, "low", "high")).toBe("medium")
  })
  it("falls back to the ITIL default for a missing cell", () => {
    expect(priorityFromMatrix([], "medium", "medium")).toBe("medium")
    expect(priorityFromMatrix([], "low", "low")).toBe("low")
    expect(priorityFromMatrix([], "high", "high")).toBe("critical")
  })
})
