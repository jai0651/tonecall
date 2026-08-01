import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tonecall — Inter-Agent Voice Handshake',
  description: 'Fax tones for AI agents, brokered by Plivo.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-mono antialiased">{children}</body>
    </html>
  );
}
