import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin"
import { Toaster } from "@/components/ui/sonner"
import { ConfirmProvider } from "@/components/common/confirm-dialog"
import { ThemeProvider, themeInitScript } from "@/lib/theme"
import "./globals.css"

export const route = defineRootRoute()
  .config({ mode: "ssg" })
  .layout(({ children }) => (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>
          <ConfirmProvider>
            {children}
            <Toaster position="bottom-right" richColors closeButton />
          </ConfirmProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  ))
