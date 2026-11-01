// Test-only stand-in for @deepseek-ai/dsh-tools' `defineTool`.
//
// The real package resolves from the DSH installation at run time; this shim
// only exists so the host half can be imported and exercised by a plain Node
// process. It mirrors the documented contract: the property-map parameter DSL
// becomes one JSON Schema, required names are enforced before execute, and the
// returned definition is registry-shaped.
export function defineTool(options) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(options.parameters ?? {})) {
    const { required: isRequired, ...schema } = spec
    properties[name] = schema
    if (isRequired) required.push(name)
  }
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    output: {
      schema: options.output.schema,
      render: options.output.render,
    },
    async execute(args, exec) {
      for (const name of required) {
        if (!(name in (args ?? {}))) throw new Error(`missing required argument: ${name}`)
      }
      return options.execute(args, exec)
    },
  }
}
