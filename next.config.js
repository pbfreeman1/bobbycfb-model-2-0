/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    const cfbRoutes = [
      'weekly-board',
      'bobby-results',
      'calibration',
      'ingest',
      'models',
      'mss-dashboard',
      'my-card',
      'pss-dashboard',
      'research',
      'results',
    ];
    const redirects = cfbRoutes.map((route) => ({
      source: `/${route}`,
      destination: `/cfb/${route}`,
      permanent: true,
    }));
    redirects.push({ source: '/dashboard', destination: '/cfb/dashboard', permanent: true });
    return redirects;
  },
};

module.exports = nextConfig;
