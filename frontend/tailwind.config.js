import colors from "tailwindcss/colors.js";

// Keep the existing dark palette and opacity modifiers in both themes.
const themed = (light, dark) => ({ opacityValue = 1 }) => {
  const rgb = hex => hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16)).join(" ");
  return `light-dark(rgb(${rgb(light)} / ${opacityValue}), rgb(${rgb(dark)} / ${opacityValue}))`;
};
const accents = ["red", "emerald", "amber", "yellow", "blue", "purple", "orange", "cyan", "indigo", "pink"];

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["DM Sans", "system-ui", "sans-serif"],
        mono: ["DM Mono", "ui-monospace", "monospace"],
      },
      colors: {
        gray: Object.fromEntries(Object.entries(colors.gray).map(([shade, dark]) =>
          [shade, themed(colors.gray[1000 - Number(shade)], dark)])),
        brand: {
          50:  "#E6F1FB",
          100: "#B5D4F4",
          300: "#85B7EB",
          400: "#5BAEE5",
          500: "#378ADD",
          600: "#185FA5",
          700: "#0C447C",
          800: "#083669",
          900: "#042C53",
        },
      },
      textColor: ({ theme }) => ({
        white: themed(colors.gray[950], "#ffffff"),
        gray: Object.fromEntries([500, 600, 700].map(shade =>
          [shade, themed(colors.gray[600], colors.gray[shade])])),
        ...Object.fromEntries([...accents, "brand"].map(name => [name,
          Object.fromEntries([200, 300, 400, 500].map(shade => [shade,
            themed(theme(`colors.${name}.700`), theme(`colors.${name}.${shade}`, theme(`colors.${name}.300`)))])),
        ])),
      }),
      backgroundColor: Object.fromEntries(accents.map(name => [name,
        Object.fromEntries([900, 950].map(shade => [shade, themed(colors[name][1000 - shade], colors[name][shade])])),
      ])),
      animation: {
        "pulse-dot": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      backgroundImage: {
        "dot-grid": "radial-gradient(circle, #ffffff08 1px, transparent 1px)",
      },
      backgroundSize: {
        "dot-grid": "24px 24px",
      },
    },
  },
  plugins: [],
}
