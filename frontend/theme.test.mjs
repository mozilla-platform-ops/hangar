// Run with: node --test theme.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import postcss from "postcss";
import { browserslistToTargets, transform } from "lightningcss";
import tailwindcss from "tailwindcss";
import config from "./tailwind.config.js";

test("theme defaults, saved choices, and shared colors", async () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // "light dark" is the value #139 stored before it was reverted; it must not stick.
  for (const [saved, expected] of [[null, "system"], ["light", "light"], ["dark", "dark"],
                                   ["system", "system"], ["light dark", "system"]]) {
    const document = { documentElement: { dataset: {} } };
    runInNewContext(script, { document, localStorage: { getItem: () => saved } });
    assert.equal(document.documentElement.dataset.theme, expected);
  }
  assert.doesNotThrow(() => runInNewContext(script, {
    document: { documentElement: { dataset: {} } },
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

// The build minifies CSS with Lightning CSS, which downlevels light-dark() into
// --lightningcss-light/--lightningcss-dark. Those variables are only redefined by
// rules that set color-scheme, so an override applied as an inline style is invisible
// to them: the whole app stays on the system theme and only inline styles flip.
test("the overrides survive the Lightning CSS light-dark() downlevel", async () => {
  const { css } = await postcss([tailwindcss({
    ...config,
    content: [{ raw: "bg-gray-950 sidebar-surface" }],
  })]).process(readFileSync(new URL("./src/index.css", import.meta.url), "utf8"), { from: undefined });

  const { code } = transform({
    filename: "index.css",
    code: Buffer.from(css),
    targets: browserslistToTargets(["safari 16"]),
  });
  const out = code.toString();

  assert.match(out, /\[data-theme="light"\][^{]*\{[^}]*--lightningcss-light: initial/);
  assert.match(out, /\[data-theme="dark"\][^{]*\{[^}]*--lightningcss-dark: initial/);
  // The sidebar goes through the same pipeline as everything else.
  assert.match(out, /\.sidebar-surface[^}]*--lightningcss-light/);
});