import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./globals.css"

export function generateMetadata(): Metadata {
  const name = process.env.PRODUCT_NAME || "ITSM Suite"
  return { title: { default: name, template: `%s · ${name}` }, robots: { index: false, follow: false } }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
