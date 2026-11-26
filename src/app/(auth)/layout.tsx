import type { ReactNode } from "react"
import { Suspense } from "react"
import { FlashFromUrl } from "@/components/client"
import { config } from "@/lib/config"

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-lg font-bold text-white">
            {config.productName().charAt(0)}
          </div>
          <div className="text-lg font-semibold text-slate-900">{config.productName()}</div>
        </div>
        <div className="card card-body shadow-md">
          <Suspense>
            <FlashFromUrl />
          </Suspense>
          {children}
        </div>
      </div>
    </div>
  )
}
