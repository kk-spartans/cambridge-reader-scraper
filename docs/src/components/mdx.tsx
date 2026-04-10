import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

function buildMdxComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...components,
  } satisfies MDXComponents;
}

export function getMDXComponents(components?: MDXComponents) {
  return buildMdxComponents(components);
}

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
