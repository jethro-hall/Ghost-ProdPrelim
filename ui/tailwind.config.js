/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ghost: {
          orange: "#FF5000",
          slate: "#0F172A",
        },
      },
    },
  },
  plugins: [],
};
