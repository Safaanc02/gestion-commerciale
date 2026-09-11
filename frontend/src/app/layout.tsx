import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "react-hot-toast";
import "./globals.css";
import MenuActionHandler from "@/components/layout/MenuActionHandler";
import DirectionSync from "@/components/layout/DirectionSync";
import AuthGuard from "@/components/layout/AuthGuard";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tijarti",
  description: "Gestion commerciale pour commerce de détail",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Tijarti",
  },
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#14293F",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <DirectionSync />
        <MenuActionHandler />
        <AuthGuard>{children}</AuthGuard>
        <Toaster position="top-right" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // The service worker is deliberately NOT registered, and any
              // previously installed one is removed along with its caches.
              //
              // It cached the application shell so the till could keep working
              // offline. On a desktop install that is a guarantee of running
              // stale code: the server is on the same machine, so it is never
              // unreachable, while an updated build stays invisible behind the
              // cached shell — including after an update that fixes a bug.
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.getRegistrations()
                    .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
                    .then((removed) => {
                      if (!removed.some(Boolean)) return null;
                      return caches.keys().then((keys) =>
                        Promise.all(keys.map((k) => caches.delete(k)))
                      ).then(() => {
                        // The page currently on screen came out of that cache,
                        // so it is reloaded once the cache is gone.
                        window.location.reload();
                      });
                    })
                    .catch(() => {});
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
