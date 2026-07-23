export type Bundler = 'webpack' | 'vite' | 'turbopack';

export interface KexariLensOptions {
  bundler: Bundler;
  cwd?: string;
}

export declare function kexariLens(options: KexariLensOptions): any;

/** Preferred Next.js integration — wrap your config, do not edit webpack() bodies. */
export declare function withKexariLens<T>(userConfig: T): T;

/** Preferred Vite integration — wrap defineConfig({...}), do not edit plugins arrays. */
export declare function withKexariVite<T>(userConfig: T): T;

export declare function transformJsx(opts: {
  content: string;
  filePath: string;
  cwd?: string;
}): string;

export declare const ATTR_SOURCE: 'data-kexari-source';
export declare const ATTR_COMPONENT: 'data-kexari-component';

export declare class KexariLensWebpackPlugin {
  constructor(options?: { cwd?: string });
  apply(compiler: any): void;
}

export declare function kexariLensVitePlugin(options?: { cwd?: string }): any;
export declare function kexariLensTurbopackRules(): Record<string, any>;

export default kexariLens;
