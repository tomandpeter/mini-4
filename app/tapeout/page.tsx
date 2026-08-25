import type { Metadata } from "next";

import TapeoutClient from "./TapeoutClient";

export const metadata: Metadata = {
  title: "MINI-4 8-bit Adder Tapeout",
  description: "Fail-closed wallet flow for MINI-4 Circuit #6.",
  robots: { index: false, follow: false },
};

export default function TapeoutPage() {
  return <TapeoutClient />;
}
