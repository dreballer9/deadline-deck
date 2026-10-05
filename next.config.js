/** @type {import('next').NextConfig} */
module.exports = {
  async redirects() {
    return [
      { source: '/', destination: '/index.html', permanent: false }
    ];
  }
};
