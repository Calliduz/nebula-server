/** @type {import('vitest/config').UserConfig} */
export default {
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
};
