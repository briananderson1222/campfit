import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        pine: {
          50: "#e8f5ee",
          100: "#c5e6d3",
          200: "#95d5b2",
          300: "#63b889",
          400: "#3e9b6b",
          500: "#2d6a4f",
          600: "#1b4332",
          700: "#143526",
          800: "#0d261a",
          900: "#071810",
        },
        cream: {
          50: "#fffef9",
          100: "#fefcf3",
          200: "#fdf9e7",
          300: "#f9f2d5",
          400: "#f4eac0",
          500: "#eee0a8",
        },
        amber: {
          50: "#fef9ee",
          100: "#fcf0d4",
          200: "#f8dfa8",
          300: "#e9c46a",
          400: "#e4b54a",
          500: "#d4a32e",
        },
        terracotta: {
          50: "#fef2ee",
          100: "#fce0d8",
          200: "#f9bfab",
          300: "#f39b7e",
          400: "#e76f51",
          500: "#d4533a",
          600: "#b8412d",
        },
        clay: {
          50: "#faf5ef",
          100: "#f3e8d9",
          200: "#e8d5bb",
          300: "#d4a373",
          400: "#c4895a",
          500: "#b07245",
        },
        bark: {
          50: "#f2efef",
          100: "#ddd7d7",
          200: "#b8aeaf",
          300: "#8e7f81",
          400: "#6b5a5c",
          500: "#4d3f41",
          600: "#3d2c2e",
          700: "#2d1f21",
          800: "#1e1415",
        },
        sky: {
          50: "#eef8fc",
          100: "#d4eef7",
          200: "#a8dcef",
          300: "#7ec8e3",
          400: "#5ab4d6",
          500: "#3a9bc4",
        },
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', "system-ui", "sans-serif"],
        body: ['"Nunito Sans"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
      },
      boxShadow: {
        camp: "0 2px 16px -2px rgba(27, 67, 50, 0.10), 0 1px 4px -1px rgba(27, 67, 50, 0.06)",
        "camp-hover":
          "0 8px 30px -4px rgba(27, 67, 50, 0.15), 0 2px 8px -2px rgba(27, 67, 50, 0.08)",
        glow: "0 0 40px -8px rgba(231, 111, 81, 0.3)",
      },
      animation: {
        "fade-in": "fadeIn 0.5s ease-out both",
        "fade-up": "fadeUp 0.6s ease-out both",
        "slide-in": "slideIn 0.4s ease-out both",
        float: "float 6s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        fadeUp: {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideIn: {
          from: { opacity: "0", transform: "translateX(-12px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
