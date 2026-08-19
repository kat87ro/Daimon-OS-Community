const path = require("path");

module.exports = {
  plugins: {
    // explicit config path — the plugin must not depend on process.cwd()
    tailwindcss: { config: path.join(__dirname, "tailwind.config.js") },
    autoprefixer: {},
  },
};
