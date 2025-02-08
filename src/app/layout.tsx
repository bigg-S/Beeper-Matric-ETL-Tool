'use_client'

import { Inter } from 'next/font/google'
import '../../global.css'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
    title: 'Matrix ETL Pipeline',
    description: 'ETL Pipeline for Beeper Matrix Client',
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <html lang="en" className="dark">
        <body className={inter.className}>
            <Providers>{children}</Providers>
        </body>
        </html>
    )
}
