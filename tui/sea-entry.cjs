(async () => {
  await import("./dist/util/env.js");
  const { createElement } = await import("react");
  const { render } = await import("ink");
  const { default: App } = await import("./dist/app.js");
  const { waitUntilExit } = render(createElement(App));
  waitUntilExit();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
