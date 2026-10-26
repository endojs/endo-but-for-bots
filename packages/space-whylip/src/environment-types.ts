// Browser build-time configuration. Vite replaces this lexical property access;
// Node caplet clients supply moduleUrl explicitly and have no import.meta.env.
export type WhylipEnvironment = { readonly WHYLIP_BOOK_PATH?: string };
declare global {
  interface ImportMetaEnv {
    readonly WHYLIP_BOOK_PATH?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
