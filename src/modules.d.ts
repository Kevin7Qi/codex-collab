// src/modules.d.ts — ambient declarations for Bun text imports
// (`import src from "../SKILL.md" with { type: "text" }` resolves to a string
// at runtime and is inlined by `bun build`; this tells tsc the same.)

declare module "*.md" {
  const text: string;
  export default text;
}
