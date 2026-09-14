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
