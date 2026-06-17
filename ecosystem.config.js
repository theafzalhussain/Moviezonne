module.exports = {
  apps: [
    {
      name: 'moviezone-pro',
      script: './server.js',
      instances: 'max',         // Server ke saare (100%) CPU cores use karega!
      exec_mode: 'cluster',     // PM2 ka Load-Balancer Mode
      autorestart: true,        // Crash hone par automatic instantly restart
      watch: false,             // Production me file watching false rakhte hain
      max_memory_restart: '1G', // Memory Leak Protection: 1GB RAM se upar jaate hi safe restart
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};