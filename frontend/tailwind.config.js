/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        brand: {
          50:  "#f0f4ff",
          100: "#dbe4ff",
          400: "#748ffc",
          500: "#4c6ef5",
          600: "#3b5bdb",
          700: "#2f4ac2",
          900: "#1a2a80",
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
