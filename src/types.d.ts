// Page templates are bundled into the Worker as text (see "rules" in wrangler.jsonc).
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "*.txt" {
  const content: string;
  export default content;
}
declare module "*.svg" {
  const content: string;
  export default content;
}
