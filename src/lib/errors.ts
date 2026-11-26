/** An error whose message is safe to show to the user. */
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code?: string
  ) {
    super(message)
    this.name = "AppError"
  }
}

export const notFound = (what = "Not found") => new AppError(what, 404, "not_found")
export const forbidden = (what = "You do not have permission to do that") => new AppError(what, 403, "forbidden")
export const conflict = (what = "Someone else changed this record. Reload and try again.") =>
  new AppError(what, 409, "conflict")

/** Message for the UI: AppError text, or a generic one (details go to the log). */
export function userMessage(err: unknown): string {
  if (err instanceof AppError) return err.message
  return "Something went wrong. Please try again."
}
