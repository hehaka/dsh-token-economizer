// DSH plugin entry: TokenEconomizer for DeepSeek Harness (docs/dsh/adr/0002).
import { NAME, createPlugin } from './src/plugin.mjs';

export const name = NAME;

export function apply(ctx, config = {}) {
  createPlugin(ctx, config);
}
