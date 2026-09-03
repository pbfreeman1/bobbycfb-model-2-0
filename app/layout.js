export const metadata = {
  title: 'BobbyCFB — Weekly Dashboard',
  description: 'Model-of-models college football spread predictions',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
