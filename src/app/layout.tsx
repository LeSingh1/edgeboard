import type { Metadata } from "next";
import { Outfit, DM_Sans, Bangers } from "next/font/google";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { BenchDrawer } from "@/components/BenchDrawer";
import { SparkleField } from "@/components/SparkleField";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800", "900"],
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const bangers = Bangers({
  variable: "--font-bangers",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "EdgeBoard — find the edge",
  description: "Personal PrizePicks prop board + lineup optimizer.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${dmSans.variable} ${bangers.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col app-shell relative overflow-x-hidden">
        <SparkleField count={9} />
        <TopNav />
        <main className="flex-1 relative z-10">{children}</main>
        <BenchDrawer />
      </body>
    </html>
  );
}
