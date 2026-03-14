module.exports = {
  apps: [
    {
      name: "self-mail",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        MAILDIR_ROOT: "/home/catchall/Maildir",
        MAX_LIST_ITEMS: 200,
      },
    },
  ],
};
