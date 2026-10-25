/**
 * ecosystem.config.cjs
 * PM2 Production Process Supervisor Configuration for PayNova Gateway
 *
 * Usage:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
  apps: [
    {
      name: 'paynova-api',
      script: 'apps/payment-api/src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 6100,
        BASE_PAYMENT_API_URL: 'http://localhost:6100',
        BASE_CHECKOUT_URL: 'http://localhost:7000'
      }
    },
    {
      name: 'paynova-checkout',
      script: 'apps/checkout-portal/src/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 7000,
        BASE_PAYMENT_API_URL: 'http://localhost:6100'
      }
    },
    {
      name: 'paynova-admin',
      script: 'apps/merchant-admin/src/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 6001,
        BASE_PAYMENT_API_URL: 'http://localhost:6100'
      }
    }
  ]
};
