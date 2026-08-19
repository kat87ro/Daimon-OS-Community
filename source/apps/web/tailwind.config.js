const path = require("path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  // anchored to this file's dir — content globs must not depend on process.cwd()
  content: [
    path.join(__dirname, "app/**/*.{ts,tsx}"),
    path.join(__dirname, "components/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {
      colors: {
        // dark operator-console base (raised contrast per the UI spec)
        ink: "#080a0d", // app background
        panel: "#10151a", // sidebar / panels
        raised: "#121a1f", // elevated cards / inputs
        line: "#262c34", // borders/dividers — a touch more visible
        // text ramp: primary #eef3f0, secondary #a8b0b7, muted #707984
        text: "#eef3f0", // primary body text (use as text-text)
        soft: "#a8b0b7", // secondary / labels
        faint: "#707984", // muted / disabled / secondary-helper only
        // accents — used deliberately (amber=primary/active, mint=healthy/done)
        amber: "#e09a3e",
        mint: "#62c98c",
        sky: "#5ec2d6",
        plum: "#c08ae0",
        rust: "#e07a7a",
      },
      fontFamily: {
        // clean sans for nav/labels/buttons/headers/cards; mono for terminal/logs/IDs
        sans: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
