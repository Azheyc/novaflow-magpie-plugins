export async function NovaFlowPlugin(input, options) {
  // A CLI launched for Library work also loads this package. Do not import
  // the runtime, create private state, bind a port or schedule sync there.
  if (process.env.NOVAFLOW_PLUGIN_CLI_CHILD === "1") return {}
  const { getRuntime } = await import("./src/runtime.mjs")
  const runtime = await getRuntime(input, options)
  runtime.attachInput(input)
  return runtime.hooks
}
