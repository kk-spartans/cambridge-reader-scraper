import type { Metadata } from "next";
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import { Provider } from "@/components/provider";
import { appName, siteUrl } from "@/lib/shared";
import "./global.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: appName,
    template: `%s | ${appName}`,
  },
  description: "CLI docs for rebuilding Cambridge Reader books into PDFs.",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} dark`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-[family:var(--font-sans)] antialiased">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
