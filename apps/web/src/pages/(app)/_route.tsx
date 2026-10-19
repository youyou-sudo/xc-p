import { defineRoute } from "@teyik0/furin"
import { AuthGate } from "@/components/layout/auth-gate"
import { route as rootRoute } from "../root"

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .layout(({ children }) => <AuthGate>{children}</AuthGate>)
