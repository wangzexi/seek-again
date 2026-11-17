declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.css" {}

/** Prism 语言包通过副作用注册到全局 Prism */
declare module "prismjs/components/*" {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module "katex/contrib/mhchem" {}
