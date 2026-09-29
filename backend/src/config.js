module.exports = {
  port: parseInt(process.env.BACKEND_PORT || '3100', 10),
  jwt: {
    secret: process.env.JWT_SECRET || 'winus-video-secret',
    expiresIn: '24h',
  },
  admin: {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASS || 'admin',
  },
};
