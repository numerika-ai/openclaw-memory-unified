/**
 * embedding/provider.ts — Abstract embedding interface
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
}
