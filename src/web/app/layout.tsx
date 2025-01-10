import { Providers } from './providers';
import './globals.css';

export const metadata = {
    title: 'Beeper Matrix ETL Tool',
    description: 'ETL pipeline for syncing Matrix/Beeper chat data to Supabase',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" className="dark">
        <body>
            <Providers>{children}</Providers>
        </body>
        </html>
    );
}
