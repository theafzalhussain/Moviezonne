module.exports = {
  apps: [
    {
      name: 'moviezone-pro',
      script: './server.js',
      instances: 1,             // Render-style single process keeps memory bounded
      exec_mode: 'fork',        // One worker only; cluster mode is unnecessary here
      autorestart: true,        // Crash hone par automatic instantly restart
      watch: false,             // Production me file watching false rakhte hain
      max_memory_restart: '384M', // Stay below Render's 512MB cap with room for spikes
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};