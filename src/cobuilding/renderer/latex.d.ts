// latex.js ships no type definitions; declare the shape we use here.
// This file must contain no top-level imports/exports so that the
// `declare module` is treated as an ambient (global) declaration.

declare module 'latex.js' {
  export class HtmlGenerator {
    constructor(options?: { hyphenate?: boolean; CustomMacros?: unknown });
  }
  export function parse(
    latex: string,
    options?: { generator: HtmlGenerator }
  ): { htmlDocument(): { head: HTMLElement; body: HTMLElement } };
}
