import type { Metadata } from "next";
import { headers } from "next/headers";

import "./globals.css";

const title = "MINI-4 — A Calculator Built On-Chain";
const description =
  "A decimal-style 1-bit calculator that returns verified NAND, NOT, AND, XOR, SUM, and CARRY results through read-only BNB Chain calls.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol ?? (host?.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(
    host ? `${protocol}://${host}` : "http://localhost:3000",
  );
  const imageUrl = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title,
    description,
    applicationName: "MINI-4",
    authors: [{ name: "tomandpeter" }],
    category: "technology",
    openGraph: {
      type: "website",
      url: metadataBase,
      siteName: "MINI-4",
      title,
      description,
      images: [
        {
          url: imageUrl,
          width: 1536,
          height: 1024,
          alt: "MINI-4 decimal-style 1-bit on-chain calculator",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
