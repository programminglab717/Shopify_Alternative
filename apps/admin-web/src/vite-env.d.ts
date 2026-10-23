/// <reference types="vite/client" />

declare module 'virtual:hatti-tokens.css';

interface ImportMetaEnv {
  /** The build's release, such as admin-web@<commit>, named in its error reports (ADR-745). */
  readonly VITE_RELEASE?: string;
}
