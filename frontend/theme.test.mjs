// Run with: node --test theme.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import config from "./tailwind.config.js";

test("theme defaults, saved choices, and shared colors", async () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const saved of [null, "light", "dark", "light dark"]) {
    const document = { documentElement: { style: {} } };
    runInNewContext(script, { document, localStorage: { getItem: () => saved } });
    assert.equal(document.documentElement.style.colorScheme, saved || "light dark");
  }
  assert.doesNotThrow(() => runInNewContext(script, {
    document: { documentElement: { style: {} } },
    localStorage: { getItem() { throw new Error("Storage blocked"); } },
  }));

  const { css } = await postcss([tailwindcss({
    ...config,
    content: [{ raw: "bg-gray-950 bg-gray-900/80 text-white text-red-400 bg-red-950/40" }],
  })]).process("@tailwind utilities;", { from: undefined });
  assert.match(css, /light-dark\(rgb\(249 250 251 \/ var\(--tw-bg-opacity/);
  assert.match(css, /light-dark\(rgb\(243 244 246 \/ 0.8\), rgb\(17 24 39 \/ 0.8\)\)/);
  assert.match(css, /light-dark\(rgb\(3 7 18 \/ var\(--tw-text-opacity/);
  assert.match(css, /light-dark\(rgb\(185 28 28 \/ var\(--tw-text-opacity/);
  assert.match(css, /light-dark\(rgb\(254 242 242 \/ 0.4\), rgb\(69 10 10 \/ 0.4\)\)/);
});
